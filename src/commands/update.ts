import { z } from 'zod';
import type { Logger } from '../lib/logger.js';
import type { Updater } from '../services/updater.js';
import type { WsClient } from '../services/websocket.js';
import type { CommandHandler } from '../lib/types.js';

type RegisterFn = (name: string, handler: CommandHandler) => void;

// --- Zod Schemas ---
const UpdateArgsSchema = z.object({
  url: z.string().url().refine(
    (val) => {
      try {
        const parsed = new URL(val);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Only http/https URLs are supported' }
  ),
  version: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid checksum format (expected SHA256 hex)'),
});

export function registerUpdateCommands(
  register: RegisterFn,
  updater: Updater,
  wsClient: WsClient,
  logger: Logger
): void {
  /**
   * agent:update — Download, verify, install an update, then restart.
   * Args: { url: string, version: string, checksum: string }
   */
  register('agent:update', async (args) => {
    const parsed = UpdateArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const urlIssue = issues.find((i) => i.path.includes('url'));
      const checksumIssue = issues.find((i) => i.path.includes('checksum'));

      if (urlIssue && urlIssue.code === 'invalid_string') {
        throw new Error('Invalid URL');
      }
      if (urlIssue && urlIssue.message === 'Only http/https URLs are supported') {
        throw new Error('Only http/https URLs are supported');
      }
      if (checksumIssue) {
        throw new Error('Invalid checksum format (expected SHA256 hex)');
      }
      throw new Error('Missing required args: url, version, checksum');
    }

    const { url, version, checksum } = parsed.data;

    // Send status update
    const sendStatus = (phase: string, detail?: Record<string, unknown>) => {
      wsClient.send({
        type: 'agent:update_status',
        payload: { phase, version, ...detail },
        timestamp: Date.now(),
      });
    };

    try {
      sendStatus('downloading');
      const filePath = await updater.download(url);

      sendStatus('verifying');
      const valid = await updater.verify(filePath, checksum);
      if (!valid) {
        sendStatus('error', { error: 'Checksum verification failed' });
        throw new Error('Checksum verification failed');
      }

      sendStatus('installing');
      await updater.install(filePath, version);

      // Clean old downloads
      updater.cleanDownloads();

      sendStatus('restarting');
      logger.info(`Update to v${version} complete. Restarting...`);

      // Delay restart to allow result to be sent
      setTimeout(() => process.exit(0), 2000);

      return { success: true, version, restarting: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendStatus('error', { error: message });
      logger.error(`Update failed: ${message}`);
      throw new Error(`Update failed: ${message}`);
    }
  });

  /**
   * agent:rollback — Rollback to the previous backup version.
   */
  register('agent:rollback', async () => {
    try {
      await updater.rollback();
      logger.info('Rollback complete. Restarting...');

      // Delay restart to allow result to be sent
      setTimeout(() => process.exit(0), 2000);

      return { success: true, restarting: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Rollback failed: ${message}`);
      throw new Error(`Rollback failed: ${message}`);
    }
  });

  /**
   * agent:update-status — Get current update status.
   */
  register('agent:update-status', async () => {
    const status = updater.getStatus();
    return { ...status } as Record<string, unknown>;
  });
}
