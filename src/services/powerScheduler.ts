import { execFile } from 'child_process';
import { getPlatform } from '../lib/platform.js';
import type { PowerScheduleConfig } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';
import type { WsClient } from './websocket.js';

/**
 * PowerScheduler — handles local cron-based shutdown and server-pushed power commands.
 *
 * Shutdown flow:
 * 1. Every minute, check if current time matches shutdownCron
 * 2. If match: send warning to server, wait shutdownWarningSeconds, then shut down
 * 3. Also listens for server-pushed "system:shutdown" via the command executor (separate)
 *
 * The server can also override/update the schedule at runtime via WebSocket.
 */
export class PowerScheduler {
  private config: PowerScheduleConfig;
  private logger: Logger;
  private wsClient: WsClient;
  private timer: NodeJS.Timeout | null = null;
  private shutdownPending = false;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor(config: PowerScheduleConfig, logger: Logger, wsClient: WsClient) {
    this.config = config;
    this.logger = logger;
    this.wsClient = wsClient;
  }

  start(): void {
    if (!this.config.shutdownCron) {
      this.logger.info('PowerScheduler: no shutdownCron configured, skipping');
      return;
    }

    this.logger.info(
      `PowerScheduler started (shutdown: "${this.config.shutdownCron}", tz: ${this.config.timezone})`
    );

    // Check every 30 seconds (cron resolution is 1 minute, but we check more often to not miss)
    this.timer = setInterval(() => {
      this.checkSchedule();
    }, 30_000);

    // Also check immediately
    this.checkSchedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    this.shutdownPending = false;
    this.logger.info('PowerScheduler stopped');
  }

  /**
   * Update the schedule at runtime (e.g., from server push).
   */
  updateSchedule(newConfig: Partial<PowerScheduleConfig>): void {
    if (newConfig.shutdownCron !== undefined) {
      this.config.shutdownCron = newConfig.shutdownCron;
    }
    if (newConfig.startupCron !== undefined) {
      this.config.startupCron = newConfig.startupCron;
    }
    if (newConfig.timezone !== undefined) {
      this.config.timezone = newConfig.timezone;
    }
    if (newConfig.shutdownWarningSeconds !== undefined) {
      this.config.shutdownWarningSeconds = newConfig.shutdownWarningSeconds;
    }
    this.logger.info(`PowerScheduler schedule updated: shutdown="${this.config.shutdownCron}"`);
  }

  /**
   * Trigger shutdown immediately (called by server command or local schedule).
   */
  triggerShutdown(reason: string): void {
    if (this.shutdownPending) {
      this.logger.info('Shutdown already pending, ignoring duplicate trigger');
      return;
    }

    this.shutdownPending = true;
    const warningSeconds = this.config.shutdownWarningSeconds ?? 60;

    this.logger.warn(`Shutdown triggered (${reason}), warning period: ${warningSeconds}s`);

    // Notify server that shutdown is imminent
    this.wsClient.send({
      type: 'agent:shutdown-warning',
      payload: {
        reason,
        shutdownInSeconds: warningSeconds,
      },
      timestamp: Date.now(),
    });

    this.shutdownTimer = setTimeout(() => {
      this.executeShutdown(reason);
    }, warningSeconds * 1_000);
  }

  /**
   * Cancel a pending scheduled shutdown.
   */
  cancelShutdown(): boolean {
    if (!this.shutdownPending || !this.shutdownTimer) {
      return false;
    }
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
    this.shutdownPending = false;

    this.logger.info('Scheduled shutdown cancelled');
    this.wsClient.send({
      type: 'agent:shutdown-cancelled',
      payload: {},
      timestamp: Date.now(),
    });
    return true;
  }

  isShutdownPending(): boolean {
    return this.shutdownPending;
  }

  // --- Private ---

  private checkSchedule(): void {
    if (!this.config.shutdownCron || this.shutdownPending) return;

    const now = this.getNowInTimezone();
    if (this.matchesCron(this.config.shutdownCron, now)) {
      this.triggerShutdown('local-schedule');
    }
  }

  private executeShutdown(reason: string): void {
    this.logger.warn(`Executing system shutdown (reason: ${reason})`);

    // Notify server before going down
    this.wsClient.send({
      type: 'agent:shutting-down',
      payload: { reason },
      timestamp: Date.now(),
    });

    const platform = getPlatform();
    let bin: string;
    let args: string[];

    switch (platform) {
      case 'windows':
        bin = 'shutdown';
        args = ['/s', '/t', '5', '/c', `LIGHTMAN scheduled shutdown: ${reason}`];
        break;
      case 'darwin':
        bin = 'shutdown';
        args = ['-h', '+1'];
        break;
      default:
        bin = 'shutdown';
        args = ['-h', 'now'];
    }

    // Give WS message time to send, then shut down
    setTimeout(() => {
      execFile(bin, args, (err) => {
        if (err) {
          this.logger.error('Shutdown exec failed:', err.message);
          this.shutdownPending = false;
        }
      });
    }, 2_000);
  }

  /**
   * Get current date/time components in the configured timezone.
   */
  private getNowInTimezone(): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } {
    const tz = this.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();

    // Use Intl to get components in the target timezone
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) => {
      const part = parts.find((p) => p.type === type);
      return part ? parseInt(part.value, 10) : 0;
    };

    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value || '';
    const dayOfWeekMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };

    return {
      minute: get('minute'),
      hour: get('hour'),
      dayOfMonth: get('day'),
      month: get('month'),
      dayOfWeek: dayOfWeekMap[weekdayStr] ?? 0,
    };
  }

  /**
   * Simple 5-field cron matcher: minute hour dayOfMonth month dayOfWeek
   * Supports: *, numbers, ranges (1-5), steps (asterisk/5), lists (1,3,5)
   */
  private matchesCron(
    expr: string,
    now: { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number }
  ): boolean {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const values = [now.minute, now.hour, now.dayOfMonth, now.month, now.dayOfWeek];

    return fields.every((field, i) => this.matchesCronField(field, values[i]));
  }

  private matchesCronField(field: string, value: number): boolean {
    // Handle list: "1,3,5"
    const parts = field.split(',');
    return parts.some((part) => {
      // Handle step: "*/5" or "1-10/2"
      const [rangeOrWild, stepStr] = part.split('/');
      const step = stepStr ? parseInt(stepStr, 10) : 1;

      if (rangeOrWild === '*') {
        return value % step === 0;
      }

      // Handle range: "1-5"
      if (rangeOrWild.includes('-')) {
        const [lo, hi] = rangeOrWild.split('-').map(Number);
        return value >= lo && value <= hi && (value - lo) % step === 0;
      }

      // Single value
      return parseInt(rangeOrWild, 10) === value;
    });
  }
}
