import { execFileSync } from 'child_process';
import { existsSync, readFileSync, openSync, writeSync, closeSync } from 'fs';

// --- RPi Detection ---

let isRpiCached: boolean | null = null;

/**
 * Detect if this machine is a Raspberry Pi by checking /proc/device-tree/model.
 */
export function isRaspberryPi(): boolean {
  if (isRpiCached !== null) return isRpiCached;
  try {
    if (!existsSync('/proc/device-tree/model')) {
      isRpiCached = false;
      return false;
    }
    const model = readFileSync('/proc/device-tree/model', 'utf-8');
    isRpiCached = model.toLowerCase().includes('raspberry pi');
    return isRpiCached;
  } catch {
    isRpiCached = false;
    return false;
  }
}

/** Reset detection cache (for testing). */
export function resetRpiCache(): void {
  isRpiCached = null;
}

// --- RPi Model Info ---

export interface RpiInfo {
  model: string | null;
  serial: string | null;
  revision: string | null;
}

export function getRpiInfo(): RpiInfo {
  const info: RpiInfo = { model: null, serial: null, revision: null };
  try {
    info.model = readFileSync('/proc/device-tree/model', 'utf-8').replace(/\0/g, '').trim();
  } catch { /* not available */ }
  try {
    const cpuinfo = readFileSync('/proc/cpuinfo', 'utf-8');
    const serialMatch = cpuinfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
    if (serialMatch) info.serial = serialMatch[1];
    const revisionMatch = cpuinfo.match(/Revision\s*:\s*([0-9a-fA-F]+)/);
    if (revisionMatch) info.revision = revisionMatch[1];
  } catch { /* not available */ }
  return info;
}

// --- GPU Temperature ---

/**
 * Read GPU temperature via vcgencmd. Returns null if not available.
 */
export function getGpuTemp(): number | null {
  try {
    const output = execFileSync('vcgencmd', ['measure_temp'], {
      timeout: 3000,
      stdio: 'pipe',
    }).toString();
    // Output format: temp=42.8'C
    const match = output.match(/temp=([\d.]+)/);
    if (match) return Math.round(parseFloat(match[1]) * 10) / 10;
    return null;
  } catch {
    return null;
  }
}

// --- Throttle Status ---

/**
 * Read throttle/undervoltage status via vcgencmd. Returns null if not available.
 * See: https://www.raspberrypi.com/documentation/computers/os.html#get_throttled
 *
 * Bit meanings:
 *  0: Under-voltage detected
 *  1: Arm frequency capped
 *  2: Currently throttled
 *  3: Soft temperature limit active
 * 16: Under-voltage has occurred
 * 17: Arm frequency capping has occurred
 * 18: Throttling has occurred
 * 19: Soft temperature limit has occurred
 */
export function getThrottled(): number | null {
  try {
    const output = execFileSync('vcgencmd', ['get_throttled'], {
      timeout: 3000,
      stdio: 'pipe',
    }).toString();
    // Output format: throttled=0x0
    const match = output.match(/throttled=(0x[0-9a-fA-F]+)/);
    if (match) return parseInt(match[1], 16);
    return null;
  } catch {
    return null;
  }
}

// --- SD Card Read-Only Check ---

/**
 * Check if the root filesystem is mounted read-only.
 */
export function isSdCardReadOnly(): boolean {
  try {
    const mounts = readFileSync('/proc/mounts', 'utf-8');
    const rootLine = mounts.split('\n').find((line) => {
      const parts = line.split(' ');
      return parts[1] === '/';
    });
    if (!rootLine) return false;
    const options = rootLine.split(' ')[3] || '';
    return options.split(',').includes('ro');
  } catch {
    return false;
  }
}

// --- Hardware Watchdog ---

let watchdogFd: number | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
const WATCHDOG_DEVICE = '/dev/watchdog';
const WATCHDOG_INTERVAL_MS = 10_000; // Pet every 10 seconds

/**
 * Start the hardware watchdog. Writes to /dev/watchdog every 10s.
 * If the agent dies, the kernel will reboot after ~15s.
 * Returns true if started, false if not available.
 */
export function startWatchdog(): boolean {
  if (watchdogFd !== null) return true; // Already running
  try {
    if (!existsSync(WATCHDOG_DEVICE)) return false;
    watchdogFd = openSync(WATCHDOG_DEVICE, 'w');
    // Pet immediately
    petWatchdog();
    // Set up periodic petting
    watchdogTimer = setInterval(petWatchdog, WATCHDOG_INTERVAL_MS);
    return true;
  } catch {
    watchdogFd = null;
    return false;
  }
}

/**
 * Stop the hardware watchdog gracefully.
 * Writes 'V' (magic close character) to disable the watchdog before closing.
 */
export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (watchdogFd !== null) {
    try {
      // Magic close character 'V' disables the watchdog
      writeSync(watchdogFd, 'V');
      closeSync(watchdogFd);
    } catch { /* ignore close errors */ }
    watchdogFd = null;
  }
}

function petWatchdog(): void {
  if (watchdogFd === null) return;
  try {
    writeSync(watchdogFd, '1');
  } catch {
    // If write fails, watchdog will trigger reboot — this is by design
  }
}
