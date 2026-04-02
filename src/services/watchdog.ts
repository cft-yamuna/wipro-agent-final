import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { KioskManager } from './kiosk.js';
import type { WsClient } from './websocket.js';
import type { HealthMonitor } from './health.js';
import type { Logger } from '../lib/logger.js';
import type { WatchdogConfig, CrashReport } from '../lib/types.js';

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 60_000,
  kioskCrashCooldownMs: 300_000,    // 5 min
  highMemoryThresholdMb: 500,
  highMemoryCooldownMs: 3_600_000,  // 1 hour
  highDiskThresholdPercent: 90,
  highDiskCooldownMs: 3_600_000,    // 1 hour
  wsDisconnectedThresholdMs: 600_000, // 10 min
  wsDisconnectedCooldownMs: 900_000,  // 15 min
};

const CHROME_CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Once per day
const CHROME_CACHE_DIR = process.platform === 'win32'
  ? 'C:\\ProgramData\\Lightman\\chrome-kiosk\\Default\\Cache'
  : '/tmp/lightman-chrome-cache';

interface RecoveryStats {
  kioskRestarts: number;
  memoryRestarts: number;
  diskCleanups: number;
  wsRestarts: number;
}

export class Watchdog {
  private kioskManager: KioskManager;
  private wsClient: WsClient;
  private healthMonitor: HealthMonitor;
  private logger: Logger;
  private config: WatchdogConfig;
  private shellMode: boolean;
  private timer: NodeJS.Timeout | null = null;
  private cooldowns: Map<string, number> = new Map();
  private stats: RecoveryStats = {
    kioskRestarts: 0,
    memoryRestarts: 0,
    diskCleanups: 0,
    wsRestarts: 0,
  };
  private wsDisconnectedSince: number | null = null;
  private shuttingDown = false;
  private serverUrl: string;
  private identity: { deviceId: string; apiKey: string };
  private lastChromeCacheCleanup = 0;
  private _multiScreenActive = false;

  constructor(
    kioskManager: KioskManager,
    wsClient: WsClient,
    healthMonitor: HealthMonitor,
    logger: Logger,
    serverUrl: string,
    identity: { deviceId: string; apiKey: string },
    config?: Partial<WatchdogConfig>,
    shellMode?: boolean
  ) {
    this.kioskManager = kioskManager;
    this.wsClient = wsClient;
    this.healthMonitor = healthMonitor;
    this.logger = logger;
    this.serverUrl = serverUrl;
    this.identity = identity;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shellMode = shellMode ?? false;
  }

  /** When multi-screen kiosk is active, watchdog should NOT restart the single kiosk */
  setMultiScreenActive(active: boolean): void {
    this._multiScreenActive = active;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.check().catch((err) => {
        this.logger.error('Watchdog check failed:', err instanceof Error ? err.message : String(err));
      });
    }, this.config.checkIntervalMs);
    this.logger.info(`Watchdog started (interval: ${this.config.checkIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Watchdog stopped');
  }

  getStats(): RecoveryStats {
    return { ...this.stats };
  }

  getCooldowns(): Record<string, number> {
    const now = Date.now();
    const result: Record<string, number> = {};
    for (const [key, expiry] of this.cooldowns) {
      const remaining = expiry - now;
      if (remaining > 0) {
        result[key] = remaining;
      }
    }
    return result;
  }

  async runDiskCleanup(): Promise<{ freedBytes: number; deletedFiles: number }> {
    let freedBytes = 0;
    let deletedFiles = 0;

    const cleanDirs = ['/tmp'];
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const dir of cleanDirs) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (!file.startsWith('lightman-')) continue;
          try {
            const filePath = join(dir, file);
            const stat = statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
              freedBytes += stat.size;
              deletedFiles += 1;
              unlinkSync(filePath);
            }
          } catch {
            // Skip files we can't access
          }
        }
      } catch {
        // Skip dirs we can't read
      }
    }

    this.logger.info(`Disk cleanup: freed ${freedBytes} bytes, deleted ${deletedFiles} files`);
    return { freedBytes, deletedFiles };
  }

  async sendCrashReport(processName: string, exitCode: number | null, signal: string | null): Promise<void> {
    try {
      const health = await this.healthMonitor.collect();
      const report: CrashReport = {
        process: processName,
        exitCode,
        signal,
        timestamp: new Date().toISOString(),
        system: {
          memPercent: health.memPercent,
          diskPercent: health.diskPercent,
          cpuUsage: health.cpuUsage,
          uptime: health.uptime,
        },
      };

      const url = `${this.serverUrl}/api/devices/${this.identity.deviceId}/crash-report`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.identity.apiKey}`,
        },
        body: JSON.stringify(report),
      });

      this.logger.info(`Crash report sent for ${processName}`);
    } catch (err) {
      this.logger.error('Failed to send crash report:', err instanceof Error ? err.message : String(err));
    }
  }

  // --- Private ---

  private async check(): Promise<void> {
    const health = await this.healthMonitor.collect();
    const now = Date.now();

    // Track WS disconnection duration
    if (!this.wsClient.isConnected()) {
      if (this.wsDisconnectedSince === null) {
        this.wsDisconnectedSince = now;
      }
    } else {
      this.wsDisconnectedSince = null;
    }

    // Rule: Kiosk crash recovery
    // Skip if multi-screen kiosk is active (it manages its own Chrome instances)
    // In shell mode, the shell BAT handles Chrome restarts — we only monitor and report
    if (this._multiScreenActive) {
      // Multi-screen mode — watchdog does not touch Chrome
    } else {
    const kioskStatus = this.kioskManager.getStatus();
    if (!kioskStatus.running && !kioskStatus.crashLoopDetected) {
      if (this.shellMode) {
        // Shell mode: just report, don't try to launch (shell handles it)
        if (this.canAct('kiosk_crash', this.config.kioskCrashCooldownMs)) {
          this.logger.warn('Watchdog: Chrome not running (shell mode — shell should relaunch)');
          this.setCooldown('kiosk_crash', this.config.kioskCrashCooldownMs);
          this.sendCrashReport('kiosk', null, null).catch(() => {});
        }
      } else if (this.canAct('kiosk_crash', this.config.kioskCrashCooldownMs)) {
        this.logger.warn('Watchdog: kiosk not running, attempting restart');
        this.stats = { ...this.stats, kioskRestarts: this.stats.kioskRestarts + 1 };
        this.setCooldown('kiosk_crash', this.config.kioskCrashCooldownMs);

        setTimeout(() => {
          this.kioskManager.launch().catch((err) => {
            this.logger.error('Watchdog kiosk restart failed:', err instanceof Error ? err.message : String(err));
          });
        }, 3000);

        this.sendCrashReport('kiosk', null, null).catch(() => {});
      }
    }
    } // end else (not multi-screen)

    // Rule: High memory — restart agent (systemd will restart)
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    if (!this.shuttingDown && health.memPercent > 80 && heapMb > this.config.highMemoryThresholdMb) {
      if (this.canAct('high_memory', this.config.highMemoryCooldownMs)) {
        this.logger.warn(`Watchdog: high memory (heap: ${Math.round(heapMb)}MB, system: ${health.memPercent}%), restarting agent`);
        this.stats = { ...this.stats, memoryRestarts: this.stats.memoryRestarts + 1 };
        this.setCooldown('high_memory', this.config.highMemoryCooldownMs);
        this.shuttingDown = true;
        setTimeout(() => process.exit(0), 1000);
        return;
      }
    }

    // Rule: High disk usage — cleanup
    if (health.diskPercent > this.config.highDiskThresholdPercent) {
      if (this.canAct('high_disk', this.config.highDiskCooldownMs)) {
        this.logger.warn(`Watchdog: high disk usage (${health.diskPercent}%), running cleanup`);
        this.stats = { ...this.stats, diskCleanups: this.stats.diskCleanups + 1 };
        this.setCooldown('high_disk', this.config.highDiskCooldownMs);
        await this.runDiskCleanup();
      }
    }

    // Rule: WS disconnected too long — restart agent
    if (
      !this.shuttingDown &&
      this.wsDisconnectedSince !== null &&
      now - this.wsDisconnectedSince > this.config.wsDisconnectedThresholdMs
    ) {
      if (this.canAct('ws_disconnected', this.config.wsDisconnectedCooldownMs)) {
        this.logger.warn(`Watchdog: WS disconnected for ${Math.round((now - this.wsDisconnectedSince) / 1000)}s, restarting agent`);
        this.stats = { ...this.stats, wsRestarts: this.stats.wsRestarts + 1 };
        this.setCooldown('ws_disconnected', this.config.wsDisconnectedCooldownMs);
        this.shuttingDown = true;
        setTimeout(() => process.exit(0), 1000);
        return;
      }
    }

    // Rule: Daily Chrome cache cleanup (prevents disk fill over months)
    if (now - this.lastChromeCacheCleanup > CHROME_CACHE_CLEANUP_INTERVAL_MS) {
      this.lastChromeCacheCleanup = now;
      this.cleanChromeCacheDir().catch(() => {});
    }
  }

  private async cleanChromeCacheDir(): Promise<void> {
    try {
      const cacheDir = CHROME_CACHE_DIR;
      const files = readdirSync(cacheDir);
      const now = Date.now();
      const maxAgeMs = 3 * 24 * 60 * 60 * 1000; // 3 days
      let cleaned = 0;

      for (const file of files) {
        try {
          const filePath = join(cacheDir, file);
          const stat = statSync(filePath);
          if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
            cleaned++;
          }
        } catch {
          // Skip files we can't access
        }
      }

      if (cleaned > 0) {
        this.logger.info(`Chrome cache cleanup: removed ${cleaned} stale files`);
      }
    } catch {
      // Cache dir may not exist yet, that's fine
    }
  }

  private canAct(action: string, _cooldownMs: number): boolean {
    const expiry = this.cooldowns.get(action);
    if (expiry && Date.now() < expiry) {
      return false;
    }
    return true;
  }

  private setCooldown(action: string, cooldownMs: number): void {
    this.cooldowns = new Map([...this.cooldowns, [action, Date.now() + cooldownMs]]);
  }
}
