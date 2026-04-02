import { execFile } from 'child_process';
import { z } from 'zod';
import type { CommandHandler } from '../lib/types.js';
import { getPlatform } from '../lib/platform.js';
import type { Logger } from '../lib/logger.js';

// --- Zod Schemas ---
const ShutdownDelayedArgsSchema = z.object({
  delayMs: z.number().finite().optional(),
});

let pendingShutdown: ReturnType<typeof setTimeout> | null = null;

interface ExecCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

function execCommand(cmd: ExecCommand, logger: Logger): void {
  execFile(cmd.bin, [...cmd.args], (err, stdout, stderr) => {
    if (err) {
      logger.error(`Exec failed: ${cmd.bin}`, err.message);
    }
    if (stderr) {
      logger.warn(`Exec stderr: ${cmd.bin}`, stderr);
    }
    if (stdout) {
      logger.debug(`Exec stdout: ${cmd.bin}`, stdout);
    }
  });
}

function getShutdownCommand(): ExecCommand {
  const platform = getPlatform();
  switch (platform) {
    case 'windows':
      return { bin: 'shutdown', args: ['/s', '/t', '0'] };
    case 'darwin':
    case 'linux':
    default:
      return { bin: 'shutdown', args: ['-h', 'now'] };
  }
}

function getRebootCommand(): ExecCommand {
  const platform = getPlatform();
  switch (platform) {
    case 'windows':
      return { bin: 'shutdown', args: ['/r', '/t', '0'] };
    case 'darwin':
    case 'linux':
    default:
      return { bin: 'shutdown', args: ['-r', 'now'] };
  }
}

function getSuspendCommand(): ExecCommand {
  const platform = getPlatform();
  switch (platform) {
    case 'linux':
      return { bin: 'systemctl', args: ['suspend'] };
    case 'windows':
      return { bin: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] };
    case 'darwin':
      return { bin: 'pmset', args: ['sleepnow'] };
    default:
      return { bin: 'systemctl', args: ['suspend'] };
  }
}

export function registerPowerCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger
): void {
  // system:shutdown — graceful shutdown with 5s delay
  register('system:shutdown', async () => {
    const cmd = getShutdownCommand();
    logger.info(`Scheduling shutdown in 5000ms: ${cmd}`);

    setTimeout(() => {
      try {
        execCommand(cmd, logger);
      } catch (err) {
        logger.error('Shutdown exec error', err instanceof Error ? err.message : String(err));
      }
    }, 5000);

    return { delayed: true, delayMs: 5000 };
  });

  // system:reboot — graceful reboot with 5s delay
  register('system:reboot', async () => {
    const cmd = getRebootCommand();
    logger.info(`Scheduling reboot in 5000ms: ${cmd}`);

    setTimeout(() => {
      try {
        execCommand(cmd, logger);
      } catch (err) {
        logger.error('Reboot exec error', err instanceof Error ? err.message : String(err));
      }
    }, 5000);

    return { delayed: true, delayMs: 5000 };
  });

  // system:suspend — immediate suspend
  register('system:suspend', async () => {
    const cmd = getSuspendCommand();
    logger.info(`Executing suspend: ${cmd}`);

    try {
      execCommand(cmd, logger);
    } catch (err) {
      logger.error('Suspend exec error', err instanceof Error ? err.message : String(err));
    }

    return { suspended: true };
  });

  // system:shutdown-delayed — shutdown after configurable delay (5s to 24h)
  register('system:shutdown-delayed', async (args) => {
    const parsed = ShutdownDelayedArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid args: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
    const rawDelay = parsed.data.delayMs ?? 60000;
    const delayMs = Math.max(5000, Math.min(rawDelay, 86_400_000));
    const cmd = getShutdownCommand();

    logger.info(`Scheduling delayed shutdown in ${delayMs}ms: ${cmd}`);

    // Clear any existing pending shutdown
    if (pendingShutdown !== null) {
      clearTimeout(pendingShutdown);
      logger.info('Cleared previous pending shutdown');
    }

    pendingShutdown = setTimeout(() => {
      try {
        execCommand(cmd, logger);
      } catch (err) {
        logger.error('Delayed shutdown exec error', err instanceof Error ? err.message : String(err));
      }
      pendingShutdown = null;
    }, delayMs);

    return { delayed: true, delayMs };
  });

  // system:cancel-shutdown — cancel a pending delayed shutdown
  register('system:cancel-shutdown', async () => {
    if (pendingShutdown !== null) {
      clearTimeout(pendingShutdown);
      pendingShutdown = null;
      logger.info('Pending shutdown cancelled');
      return { cancelled: true };
    }

    logger.info('No pending shutdown to cancel');
    return { cancelled: false, reason: 'no pending shutdown' };
  });
}
