import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process and fs before importing rpi module
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  openSync: vi.fn(() => 99),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
}));

describe('rpi.ts helpers', () => {
  let rpi: typeof import('../lib/rpi.js');
  let fsMock: {
    existsSync: ReturnType<typeof vi.fn>;
    readFileSync: ReturnType<typeof vi.fn>;
    openSync: ReturnType<typeof vi.fn>;
    writeSync: ReturnType<typeof vi.fn>;
    closeSync: ReturnType<typeof vi.fn>;
  };
  let cpMock: { execFileSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    fsMock = await import('fs') as any;
    cpMock = await import('child_process') as any;
    rpi = await import('../lib/rpi.js');
    rpi.resetRpiCache();
  });

  afterEach(() => {
    rpi.stopWatchdog();
    vi.restoreAllMocks();
  });

  // --- isRaspberryPi ---

  it('detects RPi from /proc/device-tree/model', () => {
    fsMock.existsSync.mockImplementation((p: string) => p === '/proc/device-tree/model');
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === '/proc/device-tree/model') return 'Raspberry Pi 4 Model B Rev 1.4\0';
      return '';
    });
    expect(rpi.isRaspberryPi()).toBe(true);
  });

  it('returns false when model file is missing', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(rpi.isRaspberryPi()).toBe(false);
  });

  it('returns false when model is not RPi', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('Some Other Board');
    rpi.resetRpiCache();
    expect(rpi.isRaspberryPi()).toBe(false);
  });

  it('caches the RPi detection result', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(rpi.isRaspberryPi()).toBe(false);
    // Even if we change the mock, cached result remains
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('Raspberry Pi 4');
    expect(rpi.isRaspberryPi()).toBe(false);
  });

  // --- getRpiInfo ---

  it('returns model and serial from /proc files', () => {
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === '/proc/device-tree/model') return 'Raspberry Pi 4 Model B\0';
      if (p === '/proc/cpuinfo') return 'Serial\t\t: 100000001234abcd\nRevision\t: d03114\n';
      return '';
    });
    const info = rpi.getRpiInfo();
    expect(info.model).toBe('Raspberry Pi 4 Model B');
    expect(info.serial).toBe('100000001234abcd');
    expect(info.revision).toBe('d03114');
  });

  it('returns nulls when /proc files are unavailable', () => {
    fsMock.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const info = rpi.getRpiInfo();
    expect(info.model).toBeNull();
    expect(info.serial).toBeNull();
    expect(info.revision).toBeNull();
  });

  // --- getGpuTemp ---

  it('parses GPU temperature from vcgencmd output', () => {
    cpMock.execFileSync.mockReturnValue(Buffer.from("temp=52.5'C\n"));
    expect(rpi.getGpuTemp()).toBe(52.5);
  });

  it('returns null when vcgencmd fails', () => {
    cpMock.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(rpi.getGpuTemp()).toBeNull();
  });

  // --- getThrottled ---

  it('parses throttle status from vcgencmd output', () => {
    cpMock.execFileSync.mockReturnValue(Buffer.from('throttled=0x50000\n'));
    expect(rpi.getThrottled()).toBe(0x50000);
  });

  it('returns 0 for no throttling', () => {
    cpMock.execFileSync.mockReturnValue(Buffer.from('throttled=0x0\n'));
    expect(rpi.getThrottled()).toBe(0);
  });

  it('returns null when vcgencmd fails', () => {
    cpMock.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(rpi.getThrottled()).toBeNull();
  });

  // --- isSdCardReadOnly ---

  it('detects read-only root mount', () => {
    fsMock.readFileSync.mockReturnValue('/dev/mmcblk0p2 / ext4 ro,noatime 0 0\n');
    expect(rpi.isSdCardReadOnly()).toBe(true);
  });

  it('detects read-write root mount', () => {
    fsMock.readFileSync.mockReturnValue('/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n');
    expect(rpi.isSdCardReadOnly()).toBe(false);
  });

  it('returns false when /proc/mounts is unavailable', () => {
    fsMock.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(rpi.isSdCardReadOnly()).toBe(false);
  });

  // --- Watchdog ---

  it('startWatchdog returns false when device does not exist', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(rpi.startWatchdog()).toBe(false);
  });

  it('startWatchdog opens /dev/watchdog and writes', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.openSync.mockReturnValue(42);
    const result = rpi.startWatchdog();
    expect(result).toBe(true);
    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/watchdog', 'w');
    expect(fsMock.writeSync).toHaveBeenCalledWith(42, '1');
  });

  it('stopWatchdog writes magic V and closes fd', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.openSync.mockReturnValue(42);
    rpi.startWatchdog();
    rpi.stopWatchdog();
    expect(fsMock.writeSync).toHaveBeenCalledWith(42, 'V');
    expect(fsMock.closeSync).toHaveBeenCalledWith(42);
  });
});
