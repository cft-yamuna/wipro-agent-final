import { platform } from 'os';
import type { Logger } from '../lib/logger.js';
import type { WsClient } from './websocket.js';
import type { Updater } from './updater.js';
import type { Identity } from '../lib/types.js';

/**
 * AutoUpdater — periodically polls the server to check if a newer agent version
 * is available. If found, downloads, verifies, installs, and restarts.
 *
 * Check interval: 5 minutes (default).
 * Uses device API key auth so it works without JWT.
 */

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class AutoUpdater {
  private readonly logger: Logger;
  private readonly updater: Updater;
  private readonly wsClient: WsClient;
  private readonly serverUrl: string;
  private readonly identity: Identity;
  private readonly currentVersion: string;
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(opts: {
    logger: Logger;
    updater: Updater;
    wsClient: WsClient;
    serverUrl: string;
    identity: Identity;
    currentVersion: string;
    checkIntervalMs?: number;
  }) {
    this.logger = opts.logger;
    this.updater = opts.updater;
    this.wsClient = opts.wsClient;
    this.serverUrl = opts.serverUrl;
    this.identity = opts.identity;
    this.currentVersion = opts.currentVersion;
    this.checkIntervalMs = opts.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
  }

  start(): void {
    this.logger.info(`[AutoUpdate] Started — checking every ${Math.round(this.checkIntervalMs / 1000)}s (current: v${this.currentVersion})`);

    // Initial check after 30s (let everything else boot first)
    setTimeout(() => this.check(), 30_000);

    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.checking || this.updater.isBusy()) return;
    this.checking = true;

    try {
      const plat = platform() === 'win32' ? 'windows' : 'linux';
      const url = `${this.serverUrl}/api/agent/check-update?current_version=${encodeURIComponent(this.currentVersion)}&platform=${plat}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.identity.apiKey}` },
      });

      if (!res.ok) {
        this.logger.debug(`[AutoUpdate] Check failed: HTTP ${res.status}`);
        return;
      }

      const json = await res.json() as { success: boolean; data: {
        update_available: boolean;
        version?: string;
        checksum?: string;
        download_url?: string;
      }};

      if (!json.success || !json.data.update_available) {
        this.logger.debug('[AutoUpdate] No update available');
        return;
      }

      const { version, checksum, download_url } = json.data;
      if (!version || !checksum || !download_url) {
        this.logger.warn('[AutoUpdate] Server returned incomplete update info');
        return;
      }

      this.logger.info(`[AutoUpdate] New version available: v${version} (current: v${this.currentVersion})`);

      // Notify server
      this.wsClient.send({
        type: 'agent:update_status',
        payload: { phase: 'downloading', version },
        timestamp: Date.now(),
      });

      // Build full download URL
      const fullUrl = download_url.startsWith('http')
        ? download_url
        : `${this.serverUrl}${download_url}`;

      // Download
      const filePath = await this.updater.download(fullUrl);

      // Verify
      this.wsClient.send({
        type: 'agent:update_status',
        payload: { phase: 'verifying', version },
        timestamp: Date.now(),
      });
      const valid = await this.updater.verify(filePath, checksum);
      if (!valid) {
        this.wsClient.send({
          type: 'agent:update_status',
          payload: { phase: 'error', version, error: 'Checksum mismatch' },
          timestamp: Date.now(),
        });
        this.logger.error('[AutoUpdate] Checksum mismatch — aborting');
        return;
      }

      // Install
      this.wsClient.send({
        type: 'agent:update_status',
        payload: { phase: 'installing', version },
        timestamp: Date.now(),
      });
      await this.updater.install(filePath, version);
      this.updater.cleanDownloads();

      // Restart
      this.wsClient.send({
        type: 'agent:update_status',
        payload: { phase: 'restarting', version },
        timestamp: Date.now(),
      });
      this.logger.info(`[AutoUpdate] v${version} installed. Restarting in 2s...`);
      setTimeout(() => process.exit(0), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[AutoUpdate] Error: ${msg}`);
    } finally {
      this.checking = false;
    }
  }
}
