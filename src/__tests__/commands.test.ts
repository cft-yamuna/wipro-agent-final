import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type HandlerFn = (args?: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

function createRegistry() {
  const registry = new Map<string, HandlerFn>();
  const register = (cmd: string, handler: HandlerFn) => {
    registry.set(cmd, handler);
  };
  return { registry, register };
}

// ── Global Mocks ─────────────────────────────────────────────────────────────

vi.mock('child_process', () => {
  const EventEmitter = require('events');

  const createMockSpawn = () => {
    const child = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Auto-resolve with success on next tick
    process.nextTick(() => child.emit('close', 0));
    return child;
  };

  return {
    execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, 'HDMI-1 connected primary\noutput', '');
    }),
    spawn: vi.fn(() => createMockSpawn()),
    execSync: vi.fn(() => Buffer.from('')),
    execFileSync: vi.fn(() => Buffer.from('')),
  };
});

vi.mock('../lib/platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => Buffer.from('fake-image-data')),
      unlink: vi.fn(async () => {}),
    },
  };
});

// ═════════════════════════════════════════════════════════════════════════════
// registerPowerCommands
// ═════════════════════════════════════════════════════════════════════════════

describe('registerPowerCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    vi.useFakeTimers();
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    const { registerPowerCommands } = await import('../commands/power.js');
    registerPowerCommands(register, logger as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should register all 5 power commands', () => {
    expect(registry.has('system:shutdown')).toBe(true);
    expect(registry.has('system:reboot')).toBe(true);
    expect(registry.has('system:suspend')).toBe(true);
    expect(registry.has('system:shutdown-delayed')).toBe(true);
    expect(registry.has('system:cancel-shutdown')).toBe(true);
    expect(registry.size).toBe(5);
  });

  it('system:shutdown returns delayed with 5s', async () => {
    const handler = registry.get('system:shutdown')!;
    const result = await handler();
    expect(result).toEqual({ delayed: true, delayMs: 5000 });
  });

  it('system:reboot returns delayed with 5s', async () => {
    const handler = registry.get('system:reboot')!;
    const result = await handler();
    expect(result).toEqual({ delayed: true, delayMs: 5000 });
  });

  it('system:suspend returns suspended true', async () => {
    const handler = registry.get('system:suspend')!;
    const result = await handler();
    expect(result).toEqual({ suspended: true });
  });

  it('system:cancel-shutdown returns cancelled false when no pending', async () => {
    const handler = registry.get('system:cancel-shutdown')!;
    const result = await handler();
    expect(result).toEqual({ cancelled: false, reason: 'no pending shutdown' });
  });

  it('system:shutdown-delayed returns delayed with default 60s', async () => {
    const handler = registry.get('system:shutdown-delayed')!;
    const result = await handler();
    expect(result).toEqual({ delayed: true, delayMs: 60000 });
  });

  it('system:shutdown-delayed clamps to minimum 5s', async () => {
    const handler = registry.get('system:shutdown-delayed')!;
    const result = await handler({ delayMs: 100 });
    expect(result).toEqual({ delayed: true, delayMs: 5000 });
  });

  it('system:cancel-shutdown returns cancelled true after scheduling delayed', async () => {
    const delayedHandler = registry.get('system:shutdown-delayed')!;
    await delayedHandler({ delayMs: 120000 });

    const cancelHandler = registry.get('system:cancel-shutdown')!;
    const result = await cancelHandler();
    expect(result).toEqual({ cancelled: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// registerDisplayCommands
// ═════════════════════════════════════════════════════════════════════════════

describe('registerDisplayCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;
  let mockGetPlatform: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    const platformMod = await import('../lib/platform.js');
    mockGetPlatform = platformMod.getPlatform as ReturnType<typeof vi.fn>;
    mockGetPlatform.mockReturnValue('linux');

    // Ensure execFile mock returns xrandr-like output for getConnectedDisplay
    const cp = await import('child_process');
    const mockExecFile = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(null, 'HDMI-1 connected primary\nother output', '');
    });

    const { registerDisplayCommands } = await import('../commands/display.js');
    registerDisplayCommands(register, logger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('display:brightness sets level on linux', async () => {
    const handler = registry.get('display:brightness')!;
    const result = await handler({ level: 50 });
    expect(result).toEqual({ level: 50 });
  });

  it('display:brightness rejects invalid level', async () => {
    const handler = registry.get('display:brightness')!;
    await expect(handler({ level: 150 })).rejects.toThrow('Invalid brightness level, must be 0-100');
  });

  it('display:power sets state on linux', async () => {
    const handler = registry.get('display:power')!;
    const result = await handler({ state: 'on' });
    expect(result).toEqual({ state: 'on' });
  });

  it('display:volume sets level on linux', async () => {
    const handler = registry.get('display:volume')!;
    const result = await handler({ level: 75 });
    expect(result).toEqual({ level: 75 });
  });

  it('display:rotate sets rotation on linux', async () => {
    const handler = registry.get('display:rotate')!;
    const result = await handler({ rotation: 'left' });
    expect(result).toEqual({ rotation: 'left' });
  });

  it('display:info returns raw output on linux', async () => {
    const handler = registry.get('display:info')!;
    const result = await handler();
    expect(result).toHaveProperty('raw');
    expect((result as Record<string, unknown>).raw).toContain('HDMI-1');
  });

  it('display:brightness throws not-supported on non-linux', async () => {
    mockGetPlatform.mockReturnValue('darwin');
    const handler = registry.get('display:brightness')!;
    await expect(handler({ level: 50 })).rejects.toThrow('Not supported on this platform');
  });

  it('display:power throws not-supported on non-linux', async () => {
    mockGetPlatform.mockReturnValue('windows');
    const handler = registry.get('display:power')!;
    await expect(handler({ state: 'on' })).rejects.toThrow('Not supported on this platform');
  });

  it('display:volume throws not-supported on non-linux', async () => {
    mockGetPlatform.mockReturnValue('darwin');
    const handler = registry.get('display:volume')!;
    await expect(handler({ level: 50 })).rejects.toThrow('Not supported on this platform');
  });

  it('display:rotate throws not-supported on non-linux', async () => {
    mockGetPlatform.mockReturnValue('darwin');
    const handler = registry.get('display:rotate')!;
    await expect(handler({ rotation: 'normal' })).rejects.toThrow('Not supported on this platform');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// registerKioskCommands
// ═════════════════════════════════════════════════════════════════════════════

describe('registerKioskCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;
  let mockKioskManager: {
    launch: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    mockKioskManager = {
      launch: vi.fn().mockResolvedValue({
        running: true,
        pid: 1234,
        url: 'http://localhost:3401/display',
        crashCount: 0,
        crashLoopDetected: false,
        uptimeMs: 0,
      }),
      kill: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue({
        running: true,
        pid: 5678,
        url: 'http://localhost:3401/display',
        crashCount: 0,
        crashLoopDetected: false,
        uptimeMs: 0,
      }),
      getStatus: vi.fn().mockReturnValue({
        running: false,
        pid: null,
        url: null,
        crashCount: 0,
        crashLoopDetected: false,
        uptimeMs: null,
      }),
      destroy: vi.fn(),
    };

    const { registerKioskCommands } = await import('../commands/kiosk.js');
    registerKioskCommands(register, mockKioskManager as never, logger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kiosk:launch calls kioskManager.launch()', async () => {
    const handler = registry.get('kiosk:launch')!;
    const result = await handler();
    expect(mockKioskManager.launch).toHaveBeenCalled();
    expect(result).toHaveProperty('running', true);
  });

  it('kiosk:launch passes url when provided', async () => {
    const handler = registry.get('kiosk:launch')!;
    await handler({ url: 'http://custom.url' });
    expect(mockKioskManager.launch).toHaveBeenCalledWith('http://custom.url');
  });

  it('kiosk:launch rejects non-http URLs', async () => {
    const handler = registry.get('kiosk:launch')!;
    await expect(handler({ url: 'file:///etc/passwd' })).rejects.toThrow('valid http/https URL');
  });

  it('kiosk:kill calls kioskManager.kill() and returns killed true', async () => {
    const handler = registry.get('kiosk:kill')!;
    const result = await handler();
    expect(mockKioskManager.kill).toHaveBeenCalled();
    expect(result).toEqual({ killed: true });
  });

  it('kiosk:navigate calls kioskManager.navigate() with url', async () => {
    const handler = registry.get('kiosk:navigate')!;
    const result = await handler({ url: 'http://example.com' });
    expect(mockKioskManager.navigate).toHaveBeenCalledWith('http://example.com');
    expect(result).toEqual({ navigated: true, url: 'http://example.com' });
  });

  it('kiosk:navigate throws without url', async () => {
    const handler = registry.get('kiosk:navigate')!;
    await expect(handler()).rejects.toThrow('kiosk:navigate requires args.url');
  });

  it('kiosk:navigate rejects non-http URLs', async () => {
    const handler = registry.get('kiosk:navigate')!;
    await expect(handler({ url: 'javascript:alert(1)' })).rejects.toThrow('valid http/https URL');
  });

  it('kiosk:status calls kioskManager.getStatus()', async () => {
    const handler = registry.get('kiosk:status')!;
    const result = await handler();
    expect(mockKioskManager.getStatus).toHaveBeenCalled();
    expect(result).toHaveProperty('running', false);
  });

  it('kiosk:restart calls kioskManager.restart()', async () => {
    const handler = registry.get('kiosk:restart')!;
    const result = await handler();
    expect(mockKioskManager.restart).toHaveBeenCalled();
    expect(result).toHaveProperty('running', true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// registerScreenshotCommands
// ═════════════════════════════════════════════════════════════════════════════

describe('registerScreenshotCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;
  let mockExecFileSync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockGetPlatform: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    // Set up mocks before importing
    const cp = await import('child_process');
    mockExecFileSync = cp.execFileSync as ReturnType<typeof vi.fn>;
    // Mock 'which' for commandExists and scrot for capture
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') {
        if (args[0] === 'scrot') return Buffer.from('/usr/bin/scrot');
        throw new Error('not found');
      }
      return Buffer.from('');
    });

    const fsMod = await import('fs');
    mockExistsSync = fsMod.existsSync as ReturnType<typeof vi.fn>;
    mockExistsSync.mockReturnValue(true);

    mockReadFile = fsMod.promises.readFile as ReturnType<typeof vi.fn>;
    mockReadFile.mockResolvedValue(Buffer.from('fake-screenshot-data'));

    const platformMod = await import('../lib/platform.js');
    mockGetPlatform = platformMod.getPlatform as ReturnType<typeof vi.fn>;
    mockGetPlatform.mockReturnValue('linux');

    const { registerScreenshotCommands } = await import('../commands/screenshot.js');
    registerScreenshotCommands(register, logger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures screenshot and returns captured result', async () => {
    const handler = registry.get('kiosk:screenshot')!;
    const result = await handler();

    expect(result).toMatchObject({
      captured: true,
      uploaded: false,
    });
    expect(result).toHaveProperty('size');
    expect((result as Record<string, unknown>).size).toBeGreaterThan(0);
  });

  it('throws when capture fails', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') {
        if (args[0] === 'scrot') return Buffer.from('/usr/bin/scrot');
        throw new Error('not found');
      }
      throw new Error('Command failed: scrot');
    });

    const handler = registry.get('kiosk:screenshot')!;
    await expect(handler()).rejects.toThrow('Screenshot capture failed');
  });

  it('throws when no screenshot tool is available on linux', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const handler = registry.get('kiosk:screenshot')!;
    await expect(handler()).rejects.toThrow('Screenshot capture failed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// registerRpiCommands
// ═════════════════════════════════════════════════════════════════════════════

vi.mock('../lib/rpi.js', () => {
  let isRpi = false;
  let watchdogStarted = false;
  return {
    isRaspberryPi: vi.fn(() => isRpi),
    resetRpiCache: vi.fn(),
    getRpiInfo: vi.fn(() => ({
      model: 'Raspberry Pi 4 Model B Rev 1.4',
      serial: '100000001234abcd',
      revision: 'd03114',
    })),
    getGpuTemp: vi.fn(() => 52.1),
    getThrottled: vi.fn(() => 0),
    isSdCardReadOnly: vi.fn(() => false),
    startWatchdog: vi.fn(() => {
      if (!watchdogStarted) {
        watchdogStarted = true;
        return true;
      }
      return true;
    }),
    stopWatchdog: vi.fn(() => {
      watchdogStarted = false;
    }),
    // Test helpers to toggle RPi detection
    __setIsRpi: (val: boolean) => { isRpi = val; },
    __setWatchdogStarted: (val: boolean) => { watchdogStarted = val; },
  };
});

describe('registerRpiCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;
  let rpiMock: {
    isRaspberryPi: ReturnType<typeof vi.fn>;
    startWatchdog: ReturnType<typeof vi.fn>;
    stopWatchdog: ReturnType<typeof vi.fn>;
    __setIsRpi: (val: boolean) => void;
  };

  beforeEach(async () => {
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    rpiMock = await import('../lib/rpi.js') as any;
    rpiMock.__setIsRpi(true);

    const { registerRpiCommands } = await import('../commands/rpi.js');
    registerRpiCommands(register, logger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register 3 rpi commands', () => {
    expect(registry.has('rpi:info')).toBe(true);
    expect(registry.has('rpi:watchdog-start')).toBe(true);
    expect(registry.has('rpi:watchdog-stop')).toBe(true);
  });

  it('rpi:info returns device info on RPi', async () => {
    const handler = registry.get('rpi:info')!;
    const result = await handler();
    expect(result).toMatchObject({
      model: 'Raspberry Pi 4 Model B Rev 1.4',
      serial: '100000001234abcd',
      gpuTemp: 52.1,
      throttled: 0,
      sdCardReadOnly: false,
    });
  });

  it('rpi:info throws on non-RPi', async () => {
    rpiMock.__setIsRpi(false);
    const handler = registry.get('rpi:info')!;
    await expect(handler()).rejects.toThrow('Not a Raspberry Pi');
  });

  it('rpi:watchdog-start returns started true on RPi', async () => {
    const handler = registry.get('rpi:watchdog-start')!;
    const result = await handler();
    expect(result).toEqual({ started: true });
  });

  it('rpi:watchdog-start throws on non-RPi', async () => {
    rpiMock.__setIsRpi(false);
    const handler = registry.get('rpi:watchdog-start')!;
    await expect(handler()).rejects.toThrow('Not a Raspberry Pi');
  });

  it('rpi:watchdog-start throws when watchdog not available', async () => {
    rpiMock.startWatchdog.mockReturnValue(false);
    const handler = registry.get('rpi:watchdog-start')!;
    await expect(handler()).rejects.toThrow('Watchdog device not available');
  });

  it('rpi:watchdog-stop returns stopped true on RPi', async () => {
    const handler = registry.get('rpi:watchdog-stop')!;
    const result = await handler();
    expect(result).toEqual({ stopped: true });
  });

  it('rpi:watchdog-stop throws on non-RPi', async () => {
    rpiMock.__setIsRpi(false);
    const handler = registry.get('rpi:watchdog-stop')!;
    await expect(handler()).rejects.toThrow('Not a Raspberry Pi');
  });
});
