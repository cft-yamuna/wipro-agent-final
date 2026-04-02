import { createWriteStream, createReadStream, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import http from 'http';
import https from 'https';
import { execFileSync } from 'child_process';
import type { Logger } from '../lib/logger.js';

interface UpdatePaths {
  current: string;   // /opt/lightman/agent/
  staging: string;   // /opt/lightman/agent-staging/
  backup: string;    // /opt/lightman/agent-backup/
  downloads: string; // /opt/lightman/agent-downloads/
}

interface UpdateStatus {
  phase: 'idle' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'error';
  version?: string;
  progress?: number;
  error?: string;
}

export class Updater {
  private readonly logger: Logger;
  private readonly paths: UpdatePaths;
  private status: UpdateStatus = { phase: 'idle' };

  constructor(logger: Logger, basePath?: string) {
    this.logger = logger;
    const base = basePath || '/opt/lightman';
    this.paths = {
      current: resolve(base, 'agent'),
      staging: resolve(base, 'agent-staging'),
      backup: resolve(base, 'agent-backup'),
      downloads: resolve(base, 'agent-downloads'),
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /**
   * Returns true if the updater is in the middle of an install or download.
   */
  isBusy(): boolean {
    return this.status.phase === 'downloading' ||
      this.status.phase === 'verifying' ||
      this.status.phase === 'installing';
  }

  /**
   * Download a file from URL to a local temp path.
   * Returns the local file path.
   */
  async download(url: string): Promise<string> {
    // Validate URL protocol
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https URLs are supported');
    }

    this.status = { ...this.status, phase: 'downloading' };
    this.logger.info(`Downloading update from: ${url}`);

    // Ensure downloads dir exists
    if (!existsSync(this.paths.downloads)) {
      mkdirSync(this.paths.downloads, { recursive: true });
    }

    const filename = `update-${Date.now()}.tar.gz`;
    const filePath = join(this.paths.downloads, filename);

    return new Promise<string>((resolvePromise, reject) => {
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        const ws = createWriteStream(filePath);
        pipeline(res, ws)
          .then(() => {
            this.logger.info(`Download complete: ${filePath}`);
            resolvePromise(filePath);
          })
          .catch(reject);
      });

      req.on('error', reject);
      req.setTimeout(5 * 60 * 1000, () => {
        req.destroy(new Error('Download timeout (5 minutes)'));
      });
    });
  }

  /**
   * Verify SHA256 checksum of a file.
   */
  async verify(filePath: string, expectedChecksum: string): Promise<boolean> {
    this.status = { ...this.status, phase: 'verifying' };
    this.logger.info(`Verifying checksum for: ${filePath}`);

    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    await pipeline(stream, hash);
    const actual = hash.digest('hex');

    const match = actual === expectedChecksum.toLowerCase();
    if (!match) {
      this.logger.error(`Checksum mismatch: expected ${expectedChecksum}, got ${actual}`);
    } else {
      this.logger.info('Checksum verified OK');
    }
    return match;
  }

  /**
   * Install update: extract tarball to staging, swap current -> backup, staging -> current, restart.
   */
  async install(tarballPath: string, version: string): Promise<void> {
    this.status = { phase: 'installing', version };
    this.logger.info(`Installing update v${version}...`);

    // Clean staging dir
    if (existsSync(this.paths.staging)) {
      rmSync(this.paths.staging, { recursive: true, force: true });
    }
    mkdirSync(this.paths.staging, { recursive: true });

    // Extract tarball to staging
    try {
      execFileSync('tar', ['-xzf', tarballPath, '-C', this.paths.staging], {
        timeout: 60_000,
      });
    } catch (err) {
      this.status = { phase: 'error', version, error: 'Extraction failed' };
      // Clean up staging directory on extraction failure
      try {
        if (existsSync(this.paths.staging)) {
          rmSync(this.paths.staging, { recursive: true, force: true });
        }
      } catch {
        // Non-critical cleanup error
      }
      throw new Error(`Failed to extract tarball: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Atomic swap: current -> backup, staging -> current
    try {
      // Remove old backup if it exists
      if (existsSync(this.paths.backup)) {
        rmSync(this.paths.backup, { recursive: true, force: true });
      }

      // Move current -> backup (preserve for rollback)
      if (existsSync(this.paths.current)) {
        renameSync(this.paths.current, this.paths.backup);
      }

      // Move staging -> current
      renameSync(this.paths.staging, this.paths.current);

      this.logger.info(`Update v${version} installed successfully`);
    } catch (err) {
      this.status = { phase: 'error', version, error: 'Swap failed' };
      // Attempt recovery: if backup exists and current doesn't, restore backup
      if (!existsSync(this.paths.current) && existsSync(this.paths.backup)) {
        try {
          renameSync(this.paths.backup, this.paths.current);
          this.logger.warn('Recovered from failed swap using backup');
        } catch {
          this.logger.error('CRITICAL: Failed to recover from swap failure');
        }
      }
      throw new Error(`Install swap failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Clean up downloaded tarball
    try {
      rmSync(tarballPath, { force: true });
    } catch {
      // Non-critical
    }

    this.status = { phase: 'restarting', version };
  }

  /**
   * Rollback to backup version.
   */
  async rollback(): Promise<void> {
    this.logger.info('Rolling back to backup version...');

    if (!existsSync(this.paths.backup)) {
      throw new Error('No backup version available for rollback');
    }

    // Move current -> staging (temporary)
    if (existsSync(this.paths.staging)) {
      rmSync(this.paths.staging, { recursive: true, force: true });
    }
    if (existsSync(this.paths.current)) {
      renameSync(this.paths.current, this.paths.staging);
    }

    // Move backup -> current
    renameSync(this.paths.backup, this.paths.current);

    // Clean up old current (now in staging)
    if (existsSync(this.paths.staging)) {
      rmSync(this.paths.staging, { recursive: true, force: true });
    }

    this.logger.info('Rollback complete');
  }

  /**
   * Clean old downloads, keeping only the most recent 3.
   */
  cleanDownloads(): void {
    try {
      if (!existsSync(this.paths.downloads)) return;

      const files = readdirSync(this.paths.downloads)
        .filter(f => f.endsWith('.tar.gz'))
        .map(f => ({
          name: f,
          path: join(this.paths.downloads, f),
          mtime: statSync(join(this.paths.downloads, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Keep only 3 most recent
      for (const file of files.slice(3)) {
        try {
          rmSync(file.path, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Non-critical
    }
  }
}
