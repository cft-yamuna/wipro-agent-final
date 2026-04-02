import { execFile, spawn } from 'child_process';
import { z } from 'zod';
import type { CommandHandler } from '../lib/types.js';
import { getPlatform } from '../lib/platform.js';
import type { Logger } from '../lib/logger.js';

// --- Zod Schemas ---
const BrightnessArgsSchema = z.object({
  level: z.number().int().min(0).max(100),
});

const PowerArgsSchema = z.object({
  state: z.enum(['on', 'off', 'standby']),
});

const RotateArgsSchema = z.object({
  rotation: z.enum(['normal', 'left', 'right', 'inverted']),
});

const VolumeArgsSchema = z.object({
  level: z.number().int().min(0).max(100),
});

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Pipe data to a command via stdin using spawn (no shell).
 */
function spawnWithStdin(cmd: string, args: string[], stdinData: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => reject(new Error(err.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Process exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Detect the primary connected display output name from xrandr.
 */
async function getConnectedDisplay(): Promise<string> {
  const output = await execFilePromise('xrandr', []);
  const match = output.match(/^(\S+)\s+connected/m);
  if (!match) {
    throw new Error('No connected display found');
  }
  return match[1];
}

export function registerDisplayCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger
): void {
  // display:brightness — set screen brightness (Linux only)
  register('display:brightness', async (args) => {
    if (getPlatform() !== 'linux') {
      throw new Error('Not supported on this platform');
    }

    const parsed = BrightnessArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error('Invalid brightness level, must be 0-100');
    }

    const { level } = parsed.data;
    const brightness = (level / 100).toFixed(2);

    logger.info(`Setting brightness to ${level}%`);

    const display = await getConnectedDisplay();
    await execFilePromise('xrandr', ['--output', display, '--brightness', brightness]);
    return { level };
  });

  // display:power — control display power via CEC (Linux only)
  register('display:power', async (args) => {
    if (getPlatform() !== 'linux') {
      throw new Error('Not supported on this platform');
    }

    const parsed = PowerArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error('Invalid state, must be on | off | standby');
    }

    const { state } = parsed.data;

    const cecCommands: Readonly<Record<string, string>> = {
      on: 'on 0',
      off: 'standby 0',
      standby: 'standby 0',
    };

    const cecCmd = cecCommands[state];

    logger.info(`Setting display power to ${state}`);

    // Pipe CEC command via spawn stdin (no shell)
    await spawnWithStdin('cec-client', ['-s', '-d', '1'], cecCmd + '\n');
    return { state };
  });

  // display:rotate — rotate display output (Linux only)
  register('display:rotate', async (args) => {
    if (getPlatform() !== 'linux') {
      throw new Error('Not supported on this platform');
    }

    const parsed = RotateArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error('Invalid rotation, must be normal | left | right | inverted');
    }

    const { rotation } = parsed.data;

    logger.info(`Setting display rotation to ${rotation}`);

    const display = await getConnectedDisplay();
    await execFilePromise('xrandr', ['--output', display, '--rotate', rotation]);
    return { rotation };
  });

  // display:volume — set audio volume (Linux only)
  register('display:volume', async (args) => {
    if (getPlatform() !== 'linux') {
      throw new Error('Not supported on this platform');
    }

    const parsed = VolumeArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error('Invalid volume level, must be 0-100');
    }

    const { level } = parsed.data;

    logger.info(`Setting volume to ${level}%`);

    await execFilePromise('amixer', ['set', 'Master', `${level}%`]);
    return { level };
  });

  // display:info — query display information (Linux with fallback)
  register('display:info', async () => {
    if (getPlatform() !== 'linux') {
      throw new Error('Not supported on this platform');
    }

    logger.info('Querying display info');

    const stdout = await execFilePromise('xrandr', ['--query']);
    return { raw: stdout };
  });
}
