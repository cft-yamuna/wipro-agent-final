import { spawn, execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { ChildProcess } from 'child_process';
import type { KioskConfig, KioskStatus } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';

/**
 * URL sidecar file — used in shell mode so the shell BAT reads the current
 * target URL before launching Chrome. Agent writes, shell reads.
 */
const URL_SIDECAR_FILE = process.platform === 'win32'
  ? 'C:\\ProgramData\\Lightman\\kiosk-url.txt'
  : '/tmp/lightman-kiosk-url.txt';

export class KioskManager {
  private config: KioskConfig;
  private logger: Logger;
  private shellMode: boolean;
  private process: ChildProcess | null = null;
  private currentUrl: string | null = null;
  private startedAt: number | null = null;
  private crashTimestamps: number[] = [];
  private crashLoopDetected = false;
  private restarting = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: KioskConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.shellMode = config.shellMode ?? false;

    if (this.shellMode) {
      this.logger.info('KioskManager: shell mode enabled - Chrome lifecycle managed by Windows shell');
      // Shell BAT reads slug directly from agent.config.json - no sidecar needed
    }
  }

  /**
   * Launch the kiosk browser.
   *
   * Standard mode: spawns Chrome as a child process.
   * Shell mode: writes URL to sidecar file. If Chrome isn't running, kills
   *             any stale instance (the shell's infinite loop will relaunch it).
   *             If Chrome IS running, kills it so the shell relaunches with new URL.
   */
  async launch(url?: string): Promise<KioskStatus> {
    const targetUrl = url || this.config.defaultUrl;
    this.currentUrl = targetUrl;

    if (this.shellMode) {
      return this.shellLaunch(targetUrl);
    }
    return this.standardLaunch(targetUrl);
  }

  async kill(): Promise<void> {
    if (this.shellMode) {
      // In shell mode, we just kill Chrome — the shell BAT will relaunch it
      this.killAllChrome();
      return;
    }

    this.stopPoll();
    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = null;

    return new Promise<void>((resolve) => {
      let killed = false;

      const onExit = () => {
        if (killed) return;
        killed = true;
        clearTimeout(forceKillTimer);
        resolve();
      };

      const forceKillTimer = setTimeout(() => {
        if (!killed) {
          this.logger.warn('Kiosk did not exit after SIGTERM, sending SIGKILL');
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }
      }, 5_000);

      // Remove the crash handler so kill doesn't trigger auto-restart
      proc.removeAllListeners('exit');
      proc.once('exit', onExit);

      try {
        proc.kill('SIGTERM');
      } catch {
        // Process already dead
        onExit();
      }
    });
  }

  async navigate(url: string): Promise<void> {
    this.logger.info(`Navigating kiosk to: ${url}`);

    if (this.shellMode) {
      // Write new URL → kill Chrome → shell relaunches with new URL
      this.writeUrlSidecar(url);
      this.currentUrl = url;
      this.killAllChrome();
      return;
    }

    await this.kill();
    await this.launch(url);
  }

  async restart(): Promise<KioskStatus> {
    this.logger.info('Restarting kiosk');

    if (this.shellMode) {
      // Just kill Chrome — shell relaunches it with same URL from sidecar
      this.killAllChrome();
      // Give shell time to relaunch
      await new Promise((r) => setTimeout(r, 5_000));
      return this.getStatus();
    }

    this.restarting = true;
    const url = this.currentUrl;
    await this.kill();
    return this.launch(url || undefined);
  }

  getStatus(): KioskStatus {
    if (this.shellMode) {
      return this.getShellModeStatus();
    }

    const running = this.process !== null && this.process.exitCode === null;
    return {
      running,
      pid: running && this.process ? this.process.pid ?? null : null,
      url: this.currentUrl,
      crashCount: this.crashTimestamps.length,
      crashLoopDetected: this.crashLoopDetected,
      uptimeMs: running && this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  destroy(): void {
    this.stopPoll();
    if (this.process) {
      try {
        this.process.removeAllListeners();
        this.process.kill('SIGKILL');
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
    // In shell mode, do NOT kill Chrome on agent shutdown — the shell keeps it alive
  }

  // =====================================================================
  // Shell Mode Methods
  // =====================================================================

  private async shellLaunch(targetUrl: string): Promise<KioskStatus> {
    this.currentUrl = targetUrl;

    // Shell mode: Chrome is managed by lightman-shell.bat.
    // Shell reads slug from agent.config.json directly.
    // Agent NEVER kills Chrome on startup - only on explicit navigate().
    if (this.isChromeRunning()) {
      this.logger.info('Shell mode: Chrome already running. Not touching it.');
    } else {
      this.logger.info('Shell mode: Chrome not running. Shell BAT will launch it.');
    }

    this.startedAt = this.startedAt || Date.now();
    return this.getStatus();
  }

  private getShellModeStatus(): KioskStatus {
    const running = this.isChromeRunning();
    return {
      running,
      pid: running ? this.getChromePid() : null,
      url: this.currentUrl || this.readUrlSidecar(),
      crashCount: 0, // Shell handles crash recovery, not us
      crashLoopDetected: false,
      uptimeMs: running && this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  /** Write the target URL to the sidecar file that the shell BAT reads */
  private writeUrlSidecar(url: string): void {
    try {
      writeFileSync(URL_SIDECAR_FILE, url, 'utf-8');
    } catch (err) {
      this.logger.error('Failed to write URL sidecar:', err instanceof Error ? err.message : String(err));
    }
  }

  /** Read the current URL from sidecar file */
  private readUrlSidecar(): string | null {
    try {
      if (existsSync(URL_SIDECAR_FILE)) {
        return readFileSync(URL_SIDECAR_FILE, 'utf-8').trim();
      }
    } catch {
      // Best effort
    }
    return null;
  }

  /** Check if any chrome.exe process is running */
  private isChromeRunning(): boolean {
    try {
      if (process.platform === 'win32') {
        const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
          encoding: 'utf-8',
          timeout: 5_000,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        return result.toLowerCase().includes('chrome.exe');
      } else {
        execSync('pgrep -x chrome || pgrep -x chromium-browser', {
          stdio: 'ignore',
          timeout: 5_000,
        });
        return true;
      }
    } catch {
      return false;
    }
  }

  /** Get PID of main Chrome process */
  private getChromePid(): number | null {
    try {
      if (process.platform === 'win32') {
        const result = execSync(
          'wmic process where "name=\'chrome.exe\' and CommandLine like \'%--kiosk%\'" get ProcessId /format:value',
          { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const match = result.match(/ProcessId=(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      }
    } catch {
      // Best effort
    }
    return null;
  }

  // =====================================================================
  // Standard Mode Methods (original behavior)
  // =====================================================================

  private async standardLaunch(targetUrl: string): Promise<KioskStatus> {
    // Kill existing process if running
    if (this.process) {
      await this.kill();
    }

    // Kill any leftover Chrome kiosk instances
    this.killAllChrome();

    // Delay to let Chrome fully release profile lock
    await new Promise((r) => setTimeout(r, 2_000));

    const args = [
      '--kiosk',
      '--noerrdialogs',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      ...this.config.extraArgs,
      targetUrl,
    ];

    this.logger.info(`Launching kiosk: ${this.config.browserPath} → ${targetUrl}`);

    this.process = spawn(this.config.browserPath, args, {
      stdio: 'ignore',
      detached: true,
    });

    // Unref so the agent process isn't held open by Chrome
    this.process.unref();

    this.currentUrl = targetUrl;
    this.startedAt = Date.now();
    this.crashLoopDetected = false;

    this.process.on('exit', (code) => {
      this.handleCrash(code);
    });

    this.process.on('error', (err) => {
      this.logger.error('Kiosk process error:', err.message);
      this.process = null;
      this.handleCrash(1);
    });

    this.startPoll();

    return this.getStatus();
  }

  private killAllChrome(): void {
    try {
      if (process.platform === 'win32') {
        try {
          execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore', timeout: 5_000 });
          this.logger.info('Killed Chrome instances');
        } catch {
          // No Chrome running, that's fine
        }
      } else {
        try {
          execSync('pkill -f chromium-browser || pkill -f chrome', { stdio: 'ignore', timeout: 5_000 });
        } catch {
          // No browser running
        }
      }
    } catch {
      // Best effort
    }
  }

  private handleCrash(code: number | null): void {
    // If process was intentionally killed (process set to null), skip
    if (this.process === null) {
      return;
    }

    this.process = null;
    this.stopPoll();

    // If restart() is in progress, skip auto-restart — restart() handles it
    if (this.restarting) {
      this.restarting = false;
      this.logger.info(`Kiosk exited with code ${code} during restart, deferring to restart()`);
      return;
    }

    const now = Date.now();
    const windowStart = now - this.config.crashWindowMs;
    this.crashTimestamps = [...this.crashTimestamps, now].filter((t) => t >= windowStart);

    this.logger.warn(
      `Kiosk exited with code ${code}. Crashes in window: ${this.crashTimestamps.length}/${this.config.maxCrashesInWindow}`
    );

    if (this.crashTimestamps.length >= this.config.maxCrashesInWindow) {
      this.crashLoopDetected = true;
      this.logger.error(
        `Crash loop detected (${this.crashTimestamps.length} crashes in ${this.config.crashWindowMs}ms). NOT restarting.`
      );
      return;
    }

    // Auto-restart after delay
    this.logger.info('Auto-restarting kiosk in 2s...');
    setTimeout(() => {
      this.launch(this.currentUrl || undefined).catch((err) => {
        this.logger.error('Failed to auto-restart kiosk:', err);
      });
    }, 2_000);
  }

  private startPoll(): void {
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      if (this.process && this.process.exitCode !== null) {
        // Process died but exit event didn't fire
        this.logger.warn('Poll detected kiosk process died');
        this.handleCrash(null);
      }
    }, this.config.pollIntervalMs);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
