import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('systeminformation', () => ({
  default: {
    networkInterfaces: vi.fn(),
  },
}));

vi.mock('net', async () => {
  const actual = await vi.importActual<typeof import('net')>('net');
  return {
    ...actual,
    default: {
      ...actual,
      Socket: vi.fn(),
      isIP: actual.isIP,
    },
  };
});

vi.mock('dns', () => ({
  default: {
    resolve: vi.fn(),
  },
}));

// Helpers

type HandlerFn = (args?: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

function createRegistry() {
  const registry = new Map<string, HandlerFn>();
  const register = (cmd: string, handler: HandlerFn) => {
    registry.set(cmd, handler);
  };
  return { registry, register };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// registerNetworkCommands
// ═════════════════════════════════════════════════════════════════════════════

describe('registerNetworkCommands', () => {
  let registry: Map<string, HandlerFn>;
  let register: (cmd: string, handler: HandlerFn) => void;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    logger = createMockLogger();
    const r = createRegistry();
    registry = r.registry;
    register = r.register;

    // Set up net.Socket mock for TCP ping
    const netMod = await import('net');
    const MockSocket = vi.fn().mockImplementation(() => {
      const handlers: Record<string, Function> = {};
      return {
        setTimeout: vi.fn(),
        on: vi.fn((event: string, cb: Function) => {
          handlers[event] = cb;
        }),
        connect: vi.fn((_port: number, _host: string) => {
          // Simulate immediate connection success
          if (handlers['connect']) {
            setTimeout(() => handlers['connect'](), 0);
          }
        }),
        destroy: vi.fn(),
      };
    });
    (netMod.default as unknown as Record<string, unknown>).Socket = MockSocket;

    // Set up DNS mock
    const dnsMod = await import('dns');
    const mockResolve = dnsMod.default.resolve as ReturnType<typeof vi.fn>;
    mockResolve.mockImplementation((hostname: string, cb: (err: Error | null, addrs: string[]) => void) => {
      cb(null, ['192.168.1.100']);
    });

    // Set up systeminformation mock
    const siMod = await import('systeminformation');
    const mockNetworkInterfaces = siMod.default.networkInterfaces as ReturnType<typeof vi.fn>;
    mockNetworkInterfaces.mockResolvedValue([
      { iface: 'eth0', ip4: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:ff', speed: 1000, type: 'wired', internal: false },
      { iface: 'lo', ip4: '127.0.0.1', mac: '00:00:00:00:00:00', speed: null, type: 'virtual', internal: true },
    ]);

    const { registerNetworkCommands } = await import('../commands/network.js');
    registerNetworkCommands(register, logger as never, 'http://localhost:3001');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register all 4 network commands', () => {
    expect(registry.has('network:ping')).toBe(true);
    expect(registry.has('network:bandwidth')).toBe(true);
    expect(registry.has('network:dns')).toBe(true);
    expect(registry.has('network:interfaces')).toBe(true);
    expect(registry.size).toBe(4);
  });

  it('network:interfaces returns filtered interface list', async () => {
    const handler = registry.get('network:interfaces')!;
    const result = await handler() as Record<string, unknown>;

    const interfaces = result.interfaces as Array<Record<string, unknown>>;
    // Should filter out internal (lo) and only return eth0
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0]).toMatchObject({
      name: 'eth0',
      ip4: '192.168.1.10',
      mac: 'aa:bb:cc:dd:ee:ff',
    });
  });

  it('network:ping returns latency and reachable status', async () => {
    const handler = registry.get('network:ping')!;
    const result = await handler() as Record<string, unknown>;

    expect(result).toHaveProperty('latency_ms');
    expect(result.reachable).toBe(true);
    expect(result.host).toBe('localhost');
    expect(result.port).toBe(3001);
  });

  it('network:dns resolves hostname and returns addresses', async () => {
    const handler = registry.get('network:dns')!;
    const result = await handler() as Record<string, unknown>;

    expect(result.resolved).toBe(true);
    expect(result.addresses).toEqual(['192.168.1.100']);
    expect(result.hostname).toBe('localhost');
    expect(result).toHaveProperty('time_ms');
  });

  it('network:dns returns resolved for IP addresses even when DNS fails', async () => {
    const dnsMod = await import('dns');
    const mockResolve = dnsMod.default.resolve as ReturnType<typeof vi.fn>;
    mockResolve.mockImplementation((_hostname: string, cb: (err: Error | null, addrs: string[]) => void) => {
      cb(new Error('ENOTFOUND'), []);
    });

    // Re-register with an IP-based serverUrl
    const r2 = createRegistry();
    const { registerNetworkCommands } = await import('../commands/network.js');
    registerNetworkCommands(r2.register, logger as never, 'http://192.168.1.50:3001');

    const handler = r2.registry.get('network:dns')!;
    const result = await handler() as Record<string, unknown>;

    expect(result.resolved).toBe(true);
    expect(result.addresses).toEqual(['192.168.1.50']);
    expect(result).toHaveProperty('note');
  });

  it('network:bandwidth returns speed measurement', async () => {
    // Mock fetch for bandwidth test
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024 * 1024)),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const handler = registry.get('network:bandwidth')!;
    const result = await handler() as Record<string, unknown>;

    expect(result).toHaveProperty('speed_mbps');
    expect(result).toHaveProperty('duration_ms');
    expect(result.bytes).toBe(1024 * 1024);

    vi.unstubAllGlobals();
  });

  it('network:bandwidth throws on HTTP error', async () => {
    const mockResponse = { ok: false, status: 404 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const handler = registry.get('network:bandwidth')!;
    await expect(handler()).rejects.toThrow('Bandwidth test failed');

    vi.unstubAllGlobals();
  });
});
