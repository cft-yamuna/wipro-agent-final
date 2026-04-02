import { z } from 'zod';
import type { CommandHandler, KioskStatus } from '../lib/types.js';
import type { KioskManager } from '../services/kiosk.js';
import type { MultiScreenKioskManager } from '../services/multiScreenKiosk.js';
import type { Logger } from '../lib/logger.js';

// --- Zod Schemas ---
const HttpUrlSchema = z.string().url().refine(
  (val) => {
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid http/https URL' }
);

const LaunchArgsSchema = z.object({
  url: HttpUrlSchema.optional(),
});

const NavigateArgsSchema = z.object({
  url: HttpUrlSchema,
});

export function registerKioskCommands(
  register: (command: string, handler: CommandHandler) => void,
  kioskManager: KioskManager,
  logger: Logger
): void {
  register('kiosk:launch', async (args) => {
    const parsed = LaunchArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error('kiosk:launch requires a valid http/https URL');
    }
    const { url } = parsed.data;
    logger.info(`kiosk:launch${url ? ` → ${url}` : ' (default URL)'}`);
    const status: KioskStatus = await kioskManager.launch(url);
    return status as unknown as Record<string, unknown>;
  });

  register('kiosk:kill', async () => {
    logger.info('kiosk:kill');
    await kioskManager.kill();
    return { killed: true };
  });

  register('kiosk:navigate', async (args) => {
    const parsed = NavigateArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const hasUrl = typeof args?.url === 'string' && args.url.length > 0;
      if (!hasUrl) {
        throw new Error('kiosk:navigate requires args.url');
      }
      throw new Error('kiosk:navigate requires a valid http/https URL');
    }
    const { url } = parsed.data;
    logger.info(`kiosk:navigate → ${url}`);
    await kioskManager.navigate(url);
    return { navigated: true, url };
  });

  register('kiosk:restart', async () => {
    logger.info('kiosk:restart');
    const status: KioskStatus = await kioskManager.restart();
    return status as unknown as Record<string, unknown>;
  });

  register('kiosk:status', async () => {
    const status: KioskStatus = kioskManager.getStatus();
    return status as unknown as Record<string, unknown>;
  });
}

/**
 * Register multi-screen kiosk commands.
 * These allow the server to manage individual screens on multi-display devices.
 */
export function registerMultiScreenKioskCommands(
  register: (command: string, handler: CommandHandler) => void,
  multiKiosk: MultiScreenKioskManager,
  getIdentity: () => { deviceId: string; apiKey: string },
  logger: Logger
): void {
  register('kiosk:multi:status', async () => {
    const status = multiKiosk.getStatus();
    return status as unknown as Record<string, unknown>;
  });

  register('kiosk:multi:navigate', async (args) => {
    const hardwareId = args?.hardwareId as string;
    const url = args?.url as string;
    if (!hardwareId) throw new Error('kiosk:multi:navigate requires args.hardwareId');
    if (!url) throw new Error('kiosk:multi:navigate requires args.url');
    logger.info(`kiosk:multi:navigate ${hardwareId} → ${url}`);
    await multiKiosk.navigateScreen(hardwareId, url, getIdentity());
    return { navigated: true, hardwareId, url };
  });

  register('kiosk:multi:restart', async () => {
    logger.info('kiosk:multi:restart');
    const status = await multiKiosk.restartAll(getIdentity());
    return status as unknown as Record<string, unknown>;
  });

  register('kiosk:multi:kill', async () => {
    logger.info('kiosk:multi:kill');
    await multiKiosk.killAll();
    return { killed: true };
  });
}
