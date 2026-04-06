import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname } from 'path';
import type { KioskConfig, ScreenMapping, MultiScreenKioskStatus, SingleScreenStatus } from '../lib/types.js';
import type { DetectedScreen } from '../lib/screens.js';
import type { Logger } from '../lib/logger.js';
import { resolveDetectedScreen, resolveScreenMap } from '../lib/screenMap.js';

const SHELL_MULTI_CONFIG_PATH = process.platform === 'win32'
  ? 'C:\\ProgramData\\Lightman\\kiosk-multi.json'
  : '/tmp/lightman-kiosk-multi.json';

interface ScreenInstance {
  hardwareId: string;
  mappingId: string;
  mappingUrl: string;
  screenIndex: number;
  url: string;
  screen: DetectedScreen;
  process: ChildProcess | null;
  startedAt: number | null;
  userDataDir: string;
}

/**
 * Manages multiple Chrome kiosk instances, one per physical display.
 */
export class MultiScreenKioskManager {
  private config: KioskConfig;
  private logger: Logger;
  private instances: Map<string, ScreenInstance> = new Map();
  private detectedScreens: DetectedScreen[] = [];
  private desiredScreenMap: ScreenMapping[] = [];
  private desiredIdentity: { deviceId: string; apiKey: string } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private applying = false;

  constructor(config: KioskConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  private isShellModeOnWindows(): boolean {
    return process.platform === 'win32' && !!this.config.shellMode;
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
    this.desiredScreenMap = screenMap.map((m) => ({ ...m }));
    this.desiredIdentity = { ...identity };

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
    if (this.isShellModeOnWindows()) {
      this.applyShellMultiConfig(screenMap, identity);
      this.stopPoll();
      return this.getStatus();
    }

    const resolvedMap = resolveScreenMap({
      requestedScreenMap: screenMap,
      detectedScreens: this.detectedScreens,
      totalScreens: screenMap.length,
    });

    this.logger.info(
      `[MultiKiosk] Applying screen map: ${resolvedMap.screenMap.length} mapping(s), mode=${resolvedMap.mode}`
    );

    const resolvedEntries: Array<{ mapping: ScreenMapping; screen: DetectedScreen; index: number }> = [];
    const resolvedHardwareIds = new Set<string>();

    for (let idx = 0; idx < resolvedMap.screenMap.length; idx++) {
      const mapping = resolvedMap.screenMap[idx];
      if (!mapping.hardwareId) {
        this.logger.warn(`[MultiKiosk] Mapping index ${idx} has no hardwareId, skipping`);
        continue;
      }

      const screen = this.findScreen(mapping.hardwareId);
      if (!screen) {
        this.logger.warn(`[MultiKiosk] Screen ${mapping.hardwareId} not detected, skipping`);
        continue;
      }

      if (resolvedHardwareIds.has(screen.hardwareId)) {
        this.logger.warn(`[MultiKiosk] Screen ${screen.hardwareId} is assigned more than once, skipping duplicate`);
        continue;
      }

      resolvedHardwareIds.add(screen.hardwareId);
      resolvedEntries.push({ mapping, screen, index: idx });
    }

    const mappedIds = new Set(resolvedEntries.map((e) => e.screen.hardwareId));
    for (const [hwId, instance] of this.instances) {
      if (!mappedIds.has(hwId)) {
        this.logger.info(`[MultiKiosk] Screen ${hwId} removed from map, killing Chrome`);
        this.killInstance(instance);
        this.instances.delete(hwId);
      }
    }

    for (const entry of resolvedEntries) {
      const { mapping, screen, index } = entry;
      const basePath = mapping.url || this.config.defaultUrl;
      const url = this.buildUrl(basePath, identity, index);

      const existing = this.instances.get(screen.hardwareId);
      if (existing && existing.url === url && existing.process && existing.process.exitCode === null) {
        this.logger.debug(`[MultiKiosk] Screen ${mapping.hardwareId} unchanged, skipping`);
        continue;
      }

      if (existing) {
        this.killInstance(existing);
      }

      await this.launchOnScreen(screen.hardwareId, url, screen, identity, mapping.hardwareId, mapping.url || '', index);
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
    const sep = process.platform === 'win32' ? '\\' : '/';
    const basePath = process.platform === 'win32' ? 'C:\\ProgramData\\Lightman' : '/tmp/lightman';
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
      ...this.config.extraArgs.filter((a) => !a.startsWith('--user-data-dir')),
      url,
    ];

    this.logger.info(
      `[MultiKiosk] Launching Chrome on ${hardwareId} (${screen.width}x${screen.height} @ ${screen.x},${screen.y}): ${url}`
    );

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
      const current = this.instances.get(hardwareId);
      if (!current || current.process !== proc) return;

      this.logger.warn(`[MultiKiosk] Chrome on ${hardwareId} exited with code ${code}`);
      setTimeout(() => {
        const stillCurrent = this.instances.get(hardwareId);
        if (stillCurrent && stillCurrent === instance) {
          this.logger.info(`[MultiKiosk] Auto-restarting Chrome on ${hardwareId}`);
          this.launchOnScreen(hardwareId, url, screen, identity, mappingId, mappingUrl, screenIndex).catch((err) => {
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
    let fullUrl: string;
    if (path.startsWith('http://') || path.startsWith('https://')) {
      fullUrl = path;
    } else {
      const displayPath = path.startsWith('/display/') ? path : `/display/${path.replace(/^\//, '')}`;
      fullUrl = `http://127.0.0.1:3403${displayPath}`;
    }

    const url = new URL(fullUrl);
    url.searchParams.set('deviceId', identity.deviceId);
    url.searchParams.set('apiKey', identity.apiKey);
    if (screenIndex !== undefined) {
      url.searchParams.set('screenIndex', String(screenIndex));
    }

    return url.toString();
  }

  private applyShellMultiConfig(
    screenMap: ScreenMapping[],
    identity: { deviceId: string; apiKey: string }
  ): void {
    const entries = screenMap.map((mapping, index) => {
      const resolvedHardwareId = String(mapping.hardwareId || '').trim() || String(index + 1);
      const basePath = mapping.url || this.config.defaultUrl;
      return {
        hardwareId: resolvedHardwareId,
        screenIndex: index,
        url: this.buildUrl(basePath, identity, index),
      };
    });

    try {
      const dir = dirname(SHELL_MULTI_CONFIG_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(
        SHELL_MULTI_CONFIG_PATH,
        JSON.stringify({ updatedAt: Date.now(), entries }, null, 2),
        'utf-8'
      );
      this.logger.info(`[MultiKiosk] Shell multi config written (${entries.length} screen(s))`);
    } catch (err) {
      this.logger.error('[MultiKiosk] Failed to write shell multi config:', err);
      return;
    }

    this.killShellManagedBrowsers();
  }

  private clearShellMultiConfig(): void {
    try {
      if (existsSync(SHELL_MULTI_CONFIG_PATH)) {
        rmSync(SHELL_MULTI_CONFIG_PATH, { force: true });
      }
    } catch (err) {
      this.logger.warn('[MultiKiosk] Failed to clear shell multi config:', err);
    }
  }

  private killShellManagedBrowsers(): void {
    if (process.platform !== 'win32') return;

    const browserExe = basename(this.config.browserPath || '').toLowerCase();
    const targets = new Set<string>(['chrome.exe', 'msedge.exe']);
    if (browserExe.endsWith('.exe')) {
      targets.add(browserExe);
    }

    for (const exeName of targets) {
      try {
        const killer = spawn('taskkill', ['/IM', exeName, '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.unref();
      } catch {
        // Ignore process-kill failures; shell loop can still recover.
      }
    }
  }

  /** Navigate a single screen to a new URL */
  async navigateScreen(hardwareId: string, url: string, identity: { deviceId: string; apiKey: string }): Promise<void> {
    if (this.isShellModeOnWindows()) {
      const idx = this.desiredScreenMap.findIndex((m) => String(m.hardwareId || '').trim() === String(hardwareId || '').trim());
      if (idx === -1) {
        this.logger.warn(`[MultiKiosk] Cannot navigate ${hardwareId} - not in desired map`);
        return;
      }

      const nextMap = this.desiredScreenMap.map((m) => ({ ...m }));
      nextMap[idx] = { ...nextMap[idx], url };
      await this.applyScreenMap(nextMap, identity);
      return;
    }

    const resolvedHardwareId = resolveDetectedScreen(hardwareId, this.detectedScreens)?.hardwareId || hardwareId;
    const existing = this.instances.get(resolvedHardwareId);
    if (!existing) {
      this.logger.warn(`[MultiKiosk] Cannot navigate ${hardwareId} - not in instance map`);
      return;
    }

    this.killInstance(existing);
    const fullUrl = this.buildUrl(url, identity, existing.screenIndex);
    await this.launchOnScreen(existing.hardwareId, fullUrl, existing.screen, identity, existing.mappingId, url, existing.screenIndex);
  }

  /** Kill Chrome for a specific screen instance */
  private killInstance(instance: ScreenInstance): void {
    if (!instance.process) return;

    instance.process.removeAllListeners();
    try {
      instance.process.kill('SIGTERM');
    } catch {
      // Already dead.
    }
    instance.process = null;
  }

  /** Find a detected screen by display number or full hardware ID */
  private findScreen(id: string): DetectedScreen | undefined {
    return resolveDetectedScreen(id, this.detectedScreens);
  }

  /** Kill all Chrome instances */
  async killAll(options?: { clearDesired?: boolean }): Promise<void> {
    for (const [, instance] of this.instances) {
      this.killInstance(instance);
    }
    this.instances.clear();
    this.stopPoll();

    if (this.isShellModeOnWindows()) {
      this.clearShellMultiConfig();
      this.killShellManagedBrowsers();
    }

    if (options?.clearDesired !== false) {
      this.desiredScreenMap = [];
      this.desiredIdentity = null;
    }
  }

  /** Restart all Chrome instances */
  async restartAll(identity: { deviceId: string; apiKey: string }): Promise<MultiScreenKioskStatus> {
    this.logger.info('[MultiKiosk] Restarting all Chrome instances');

    if (this.isShellModeOnWindows()) {
      if (this.desiredScreenMap.length === 0) {
        return this.getStatus();
      }
      this.killShellManagedBrowsers();
      await new Promise((r) => setTimeout(r, 2_000));
      return this.applyScreenMap(this.desiredScreenMap, identity);
    }

    const mappings: ScreenMapping[] = [];
    for (const [, instance] of this.instances) {
      mappings.push({ hardwareId: instance.mappingId, url: instance.mappingUrl, label: undefined });
    }

    await this.killAll({ clearDesired: false });
    await new Promise((r) => setTimeout(r, 2_000));
    return this.applyScreenMap(mappings, identity);
  }

  hasDesiredScreenMap(): boolean {
    return this.desiredScreenMap.length > 0;
  }

  async reapplyDesiredMap(identity?: { deviceId: string; apiKey: string }): Promise<MultiScreenKioskStatus> {
    const id = identity || this.desiredIdentity;
    if (!id || this.desiredScreenMap.length === 0) {
      return this.getStatus();
    }

    return this.applyScreenMap(this.desiredScreenMap, id);
  }

  /** Get status of all screen instances */
  getStatus(): MultiScreenKioskStatus {
    if (this.isShellModeOnWindows() && this.desiredIdentity && this.desiredScreenMap.length > 0) {
      return {
        screens: this.desiredScreenMap.map((mapping, index) => ({
          hardwareId: String(mapping.hardwareId || '').trim() || String(index + 1),
          url: this.buildUrl(mapping.url || this.config.defaultUrl, this.desiredIdentity!, index),
          running: false,
          pid: null,
          uptimeMs: null,
        })),
      };
    }

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
    if (this.isShellModeOnWindows()) {
      return this.desiredScreenMap.length > 0;
    }
    return this.instances.size > 0;
  }

  /** Cleanup on agent shutdown */
  destroy(): void {
    this.stopPoll();
    for (const [, instance] of this.instances) {
      if (!instance.process) continue;
      try {
        instance.process.removeAllListeners();
        instance.process.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      instance.process = null;
    }
    this.instances.clear();
    this.desiredScreenMap = [];
    this.desiredIdentity = null;
  }

  private startPoll(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      for (const [, instance] of this.instances) {
        if (instance.process && instance.process.exitCode !== null) {
          this.logger.warn(`[MultiKiosk] Poll: Chrome on ${instance.hardwareId} died`);
          // Exit handler will auto-restart.
        }
      }
    }, this.config.pollIntervalMs);
  }

  private stopPoll(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
