import type { CommandHandler } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';

// --- Register Serial Commands ---

export function registerSerialCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger
): void {
  // serial:close — placeholder
  register('serial:close', async (args) => {
    const port = args?.port as string;
    if (!port) throw new Error('Port path is required');
    logger.info(`serial:close requested for ${port}`);
    return { status: 'acknowledged', port };
  });
}
