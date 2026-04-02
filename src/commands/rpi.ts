import type { CommandHandler } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';
import { isRaspberryPi, getRpiInfo, getGpuTemp, getThrottled, isSdCardReadOnly, startWatchdog, stopWatchdog } from '../lib/rpi.js';

export function registerRpiCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger
): void {
  // rpi:info — returns model, serial, revision, gpuTemp, throttled, sdCardReadOnly
  register('rpi:info', async () => {
    if (!isRaspberryPi()) {
      throw new Error('Not a Raspberry Pi');
    }
    const info = getRpiInfo();
    return {
      ...info,
      gpuTemp: getGpuTemp(),
      throttled: getThrottled(),
      sdCardReadOnly: isSdCardReadOnly(),
    };
  });

  // rpi:watchdog-start — start hardware watchdog
  register('rpi:watchdog-start', async () => {
    if (!isRaspberryPi()) {
      throw new Error('Not a Raspberry Pi');
    }
    const started = startWatchdog();
    if (!started) {
      throw new Error('Watchdog device not available. Ensure /dev/watchdog exists and agent has permissions.');
    }
    logger.info('Hardware watchdog started');
    return { started: true };
  });

  // rpi:watchdog-stop — stop hardware watchdog gracefully
  register('rpi:watchdog-stop', async () => {
    if (!isRaspberryPi()) {
      throw new Error('Not a Raspberry Pi');
    }
    stopWatchdog();
    logger.info('Hardware watchdog stopped');
    return { stopped: true };
  });
}
