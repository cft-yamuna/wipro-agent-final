import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WsMessage, LogEntry } from '../lib/types.js';

// ── Mock WsClient ────────────────────────────────────────────────────────────

function createMockWsClient() {
  return {
    send: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createLogEntry(overrides?: Partial<LogEntry>): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'test log message',
    source: 'test',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// LogForwarder
// ═════════════════════════════════════════════════════════════════════════════

describe('LogForwarder', () => {
  let wsClient: ReturnType<typeof createMockWsClient>;
  let logger: ReturnType<typeof createMockLogger>;
  let LogForwarder: typeof import('../services/logForwarder.js').LogForwarder;

  beforeEach(async () => {
    vi.useFakeTimers();
    wsClient = createMockWsClient();
    logger = createMockLogger();

    const mod = await import('../services/logForwarder.js');
    LogForwarder = mod.LogForwarder;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('buffers log entries via onLog()', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never);
    const entry = createLogEntry();
    forwarder.onLog(entry);

    // Buffer should hold the entry but not send yet
    expect(wsClient.send).not.toHaveBeenCalled();
  });

  it('flushes buffer via WS send when flush() is called', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never);
    const entry1 = createLogEntry({ message: 'log 1' });
    const entry2 = createLogEntry({ message: 'log 2' });

    forwarder.onLog(entry1);
    forwarder.onLog(entry2);
    forwarder.flush();

    expect(wsClient.send).toHaveBeenCalledTimes(1);
    const msg = wsClient.send.mock.calls[0][0] as WsMessage;
    expect(msg.type).toBe('agent:logs');
    expect((msg.payload as Record<string, unknown>).entries).toHaveLength(2);
  });

  it('does not send when buffer is empty', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never);
    forwarder.flush();

    expect(wsClient.send).not.toHaveBeenCalled();
  });

  it('auto-flushes when buffer reaches maxBatchSize', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never, { maxBatchSize: 5 });

    for (let i = 0; i < 5; i++) {
      forwarder.onLog(createLogEntry({ message: `log ${i}` }));
    }

    // Should auto-flush once buffer reaches 5
    expect(wsClient.send).toHaveBeenCalledTimes(1);
    const msg = wsClient.send.mock.calls[0][0] as WsMessage;
    expect((msg.payload as Record<string, unknown>).entries).toHaveLength(5);
  });

  it('respects default maxBatchSize of 100', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never);

    // Add 99 entries — should NOT auto-flush
    for (let i = 0; i < 99; i++) {
      forwarder.onLog(createLogEntry({ message: `log ${i}` }));
    }
    expect(wsClient.send).not.toHaveBeenCalled();

    // Add 1 more (reaching 100) — SHOULD auto-flush
    forwarder.onLog(createLogEntry({ message: 'log 99' }));
    expect(wsClient.send).toHaveBeenCalledTimes(1);
    const msg = wsClient.send.mock.calls[0][0] as WsMessage;
    expect((msg.payload as Record<string, unknown>).entries).toHaveLength(100);
  });

  it('start() sets an interval that calls flush()', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never, { batchIntervalMs: 10000 });
    forwarder.start();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Log forwarder started'));

    // Add an entry, advance timer
    forwarder.onLog(createLogEntry());
    vi.advanceTimersByTime(10000);

    expect(wsClient.send).toHaveBeenCalledTimes(1);
  });

  it('stop() clears interval and does a final flush', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never, { batchIntervalMs: 10000 });
    forwarder.start();

    forwarder.onLog(createLogEntry({ message: 'final log' }));
    forwarder.stop();

    // Final flush should have sent
    expect(wsClient.send).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Log forwarder stopped');

    // After stop, interval should not fire
    wsClient.send.mockClear();
    forwarder.onLog(createLogEntry({ message: 'after stop' }));
    vi.advanceTimersByTime(20000);

    // Only the interval would have triggered a flush, but it's stopped
    expect(wsClient.send).not.toHaveBeenCalled();
  });

  it('flush clears the buffer after sending', () => {
    const forwarder = new LogForwarder(wsClient as never, logger as never);
    forwarder.onLog(createLogEntry());
    forwarder.flush();

    // Second flush should be a no-op (empty buffer)
    forwarder.flush();
    expect(wsClient.send).toHaveBeenCalledTimes(1);
  });
});
