import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { KioskConfig, ScreenMapping, MultiScreenKioskStatus, SingleScreenStatus } from '../lib/types.js';
import type { DetectedScreen } from '../lib/screens.js';
import type { Logger } from '../lib/logger.js';

interface ScreenInstance {
  hardwareId: string;
  mappingId: string;   // original hardwareId from admin ("1","2","3")
  mappingUrl: string;  // original URL from mapping (before buildUrl)
  screenIndex: number; // position in the screenMap array
  url: string;         // fully built URL with credentials
  screen: DetectedScreen;
  process: ChildProcess | null;
  startedAt: number | null;
  userDataDir: string;
}

/**
 * Manages multiple Chrome kiosk instances — one per physical display.
 * Each Chrome gets its own --user-data-dir and --window-position to target the correct screen.
 */
export class MultiScreenKioskManager {
  private config: KioskConfig;
  private logger: Logger;
  private instances: Map<string, ScreenInstance> = new Map();
  private detectedScreens: DetectedScreen[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private applying = false;

  constructor(config: KioskConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Update the list of detected physical screens */
  setDetectedScreens(screens: DetectedScreen[]): void {
    this.detectedScreens = screens;
    this.logger.info(`[MultiKiosk] Updated detected screens: ${screens.length} display(s)`);
  }

  /**
   * Apply a screen mapping from the server/admin.
   * Launches Chrome on screens that have new URLs, kills those that were removed,
   * and relaunches those whose URL changed.
   */
  async applyScreenMap(screenMap: ScreenMapping[], identity: { deviceId: string; apiKey: string }): Promise<MultiScreenKioskStatus> {
    // Guard against concurrent calls
    if (this.applying) {
      this.logger.warn('[MultiKiosk] applyScreenMap already in progress, skipping');
      return this.getStatus();
    }
    this.applying = true;
    try {
      return await this._applyScreenMap(screenMap, identity);
    } finally {
      this.applying = false;
    }
  }

  private async _applyScreenMap(screenMap: ScreenMapping[], identity: { deviceId: string; apiKey: string }): Promise<MultiScreenKioskStatus> {
    this.logger.info(`[MultiKiosk] Applying screen map: ${screenMap.length} mapping(s)`);

    // Find which hardwareIds are no longer mapped — kill those
    const mappedIds = new Set(screenMap.map(m => m.hardwareId));
    for (const [hwId, instance] of this.instances) {
      if (!mappedIds.has(hwId)) {
        this.logger.info(`[MultiKiosk] Screen ${hwId} removed from map, killing Chrome`);
        this.killInstance(instance);
        this.instances.delete(hwId);
      }
    }

    // Launch or relaunch for each mapping
    for (let idx = 0; idx < screenMap.length; idx++) {
      const mapping = screenMap[idx];
      // Match by display number: admin saves "1","2","3" — agent detects "\\.\DISPLAY1" etc.
      const screen = this.findScreen(mapping.hardwareId);
      if (!screen) {
        this.logger.warn(`[MultiKiosk] Screen ${mapping.hardwareId} not detected, skipping`);
        continue;
      }

      // Use the mapping's URL if provided, otherwise use the default kiosk URL
      // The screenIndex is the mapping's position (idx) in the array
      const basePath = mapping.url || this.config.defaultUrl;
      const url = this.buildUrl(basePath, identity, idx);

      const existing = this.instances.get(mapping.hardwareId);
      if (existing && existing.url === url && existing.process && existing.process.exitCode === null) {
        // Same URL, Chrome still running — skip
        this.logger.debug(`[MultiKiosk] Screen ${mapping.hardwareId} unchanged, skipping`);
        continue;
      }

      // Kill existing if URL changed
      if (existing) {
        this.killInstance(existing);
      }

      // Launch new Chrome on this screen
      await this.launchOnScreen(screen.hardwareId, url, screen, identity, mapping.hardwareId, mapping.url || '', idx);
    }

    this.startPoll();
    return this.getStatus();
  }

  /** Launch a single Chrome instance on a specific screen */
  private async launchOnScreen(
    hardwareId: string,
    url: string,
    screen: DetectedScreen,
    identity: { deviceId: string; apiKey: string },
    mappingId: string = hardwareId,
    mappingUrl: string = '',
    screenIndex: number = 0
  ): Promise<void> {
    // Each screen gets its own user-data-dir to avoid profile lock conflicts
    const sep = process.platform === 'win32' ? '\\' : '/';
    const basePath = process.platform === 'win32'
      ? 'C:\\ProgramData\\Lightman'
      : '/tmp/lightman';
    const userDataDir = `${basePath}${sep}chrome-kiosk-screen-${screen.index}`;

    const args = [
      '--kiosk',
      '--noerrdialogs',
      '--disable-infobars',
      '--disable-session-crashed-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-position=${screen.x},${screen.y}`,
      `--window-size=${screen.width},${screen.height}`,
      `--user-data-dir=${userDataDir}`,
      ...this.config.extraArgs.filter(a => !a.startsWith('--user-data-dir')),
      url,
    ];

    this.logger.info(`[MultiKiosk] Launching Chrome on ${hardwareId} (${screen.width}x${screen.height} @ ${screen.x},${screen.y}): ${url}`);

    const proc = spawn(this.config.browserPath, args, {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();

    const instance: ScreenInstance = {
      hardwareId,
      mappingId,
      mappingUrl,
      screenIndex,
      url,
      screen,
      process: proc,
      startedAt: Date.now(),
      userDataDir,
    };

    proc.on('exit', (code) => {
      // Only auto-restart if this instance is still current (not replaced by a newer applyScreenMap)
      const current = this.instances.get(hardwareId);
      if (!current || current.process !== proc) return;
      this.logger.warn(`[MultiKiosk] Chrome on ${hardwareId} exited with code ${code}`);
      setTimeout(() => {
        const stillCurrent = this.instances.get(hardwareId);
        if (stillCurrent && stillCurrent === instance) {
          this.logger.info(`[MultiKiosk] Auto-restarting Chrome on ${hardwareId}`);
          this.launchOnScreen(hardwareId, url, screen, identity, mappingId, mappingUrl, screenIndex).catch(err => {
            this.logger.error(`[MultiKiosk] Failed to restart Chrome on ${hardwareId}:`, err);
          });
        }
      }, 3_000);
    });

    proc.on('error', (err) => {
      this.logger.error(`[MultiKiosk] Chrome error on ${hardwareId}:`, err.message);
    });

    this.instances.set(hardwareId, instance);
  }

  /** Build the full URL with device credentials and screenIndex */
  private buildUrl(path: string, identity: { deviceId: string; apiKey: string }, screenIndex?: number): string {
    // If path is already a full URL, use it; otherwise prepend the local static server
    let fullUrl: string;
    if (path.startsWith('http://') || path.startsWith('https://')) {
      fullUrl = path;
    } else {
      // Ensure display URL format: /display/{slug}
      const displayPath = path.startsWith('/display/') ? path : `/display/${path.replace(/^\//, '')}`;
      fullUrl = `http://localhost:3403${displayPath}`;
    }

    const url = new URL(fullUrl);
    url.searchParams.set('deviceId', identity.deviceId);
    url.searchParams.set('apiKey', identity.apiKey);
    if (screenIndex !== undefined) {
      url.searchParams.set('screenIndex', String(screenIndex));
    }
    return url.toString();
  }

  /** Navigate a single screen to a new URL */
  async navigateScreen(hardwareId: string, url: string, identity: { deviceId: string; apiKey: string }): Promise<void> {
    const existing = this.instances.get(hardwareId);
    if (!existing) {
      this.logger.warn(`[MultiKiosk] Cannot navigate ${hardwareId} — not in instance map`);
      return;
    }

    this.killInstance(existing);
    const fullUrl = this.buildUrl(url, identity);
    await this.launchOnScreen(hardwareId, fullUrl, existing.screen, identity);
  }

  /** Kill Chrome for a specific screen instance */
  private killInstance(instance: ScreenInstance): void {
    if (instance.process) {
      instance.process.removeAllListeners();
      try {
        instance.process.kill('SIGTERM');
      } catch {
        // Already dead
      }
      instance.process = null;
    }
  }

  /** Find a detected screen by display number or full hardware ID */
  private findScreen(id: string): DetectedScreen | undefined {
    // Direct match (full hardware ID like "\\.\DISPLAY1")
    const direct = this.detectedScreens.find(s => s.hardwareId === id);
    if (direct) return direct;

    // Match by display number ("1" → "\\.\DISPLAY1") — anchored to avoid "1" matching "DISPLAY11"
    if (/^\d+$/.test(id)) {
      const suffix = 'DISPLAY' + id;
      return this.detectedScreens.find(s => {
        const name = s.hardwareId.toUpperCase();
        return name.endsWith(suffix) && (name.length === suffix.length || name[name.length - suffix.length - 1] === '\\');
      });
    }

    return undefined;
  }

  /** Kill all Chrome instances */
  async killAll(): Promise<void> {
    for (const [, instance] of this.instances) {
      this.killInstance(instance);
    }
    this.stopPoll();
  }

  /** Restart all Chrome instances */
  async restartAll(identity: { deviceId: string; apiKey: string }): Promise<MultiScreenKioskStatus> {
    this.logger.info('[MultiKiosk] Restarting all Chrome instances');
    const mappings: ScreenMapping[] = [];
    for (const [, instance] of this.instances) {
      mappings.push({ hardwareId: instance.mappingId, url: instance.mappingUrl });
    }
    await this.killAll();
    await new Promise(r => setTimeout(r, 2_000));
    return this.applyScreenMap(mappings, identity);
  }

  /** Get status of all screen instances */
  getStatus(): MultiScreenKioskStatus {
    const screens: SingleScreenStatus[] = [];
    for (const [, instance] of this.instances) {
      const running = instance.process !== null && instance.process.exitCode === null;
      screens.push({
        hardwareId: instance.hardwareId,
        url: instance.url,
        running,
        pid: running && instance.process ? instance.process.pid ?? null : null,
        uptimeMs: running && instance.startedAt ? Date.now() - instance.startedAt : null,
      });
    }
    return { screens };
  }

  /** Check if any screens are actively managed */
  isActive(): boolean {
    return this.instances.size > 0;
  }

  /** Cleanup on agent shutdown */
  destroy(): void {
    this.stopPoll();
    for (const [, instance] of this.instances) {
      if (instance.process) {
        try {
          instance.process.removeAllListeners();
          instance.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
        instance.process = null;
      }
    }
    this.instances.clear();
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const [, instance] of this.instances) {
        if (instance.process && instance.process.exitCode !== null) {
          this.logger.warn(`[MultiKiosk] Poll: Chrome on ${instance.hardwareId} died`);
          // exit handler will auto-restart
        }
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
