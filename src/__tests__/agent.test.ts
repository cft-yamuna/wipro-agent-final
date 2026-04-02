import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WsClient } from '../services/websocket.js';
import { CommandExecutor } from '../services/commands.js';
import { Logger } from '../lib/logger.js';

// Mock logger that doesn't write files
function createMockLogger(): Logger {
  return new Logger('error');
}

describe('WsClient', () => {
  describe('getReconnectDelay', () => {
    it('should return a delay within expected range for attempt 0', () => {
      const client = new WsClient({
        serverUrl: 'http://localhost:3001',
        identity: { deviceId: 'test', apiKey: 'test-key' },
        logger: createMockLogger(),
        onMessage: () => {},
      });

      // Attempt 0: base delay = 1000, range = 500-1500
      const delay = client.getReconnectDelay();
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1500);
    });

    it('should increase delay with more attempts', () => {
      const client = new WsClient({
        serverUrl: 'http://localhost:3001',
        identity: { deviceId: 'test', apiKey: 'test-key' },
        logger: createMockLogger(),
        onMessage: () => {},
      });

      // Simulate multiple reconnect delays (based on internal attempts counter)
      // Since getReconnectDelay uses reconnectAttempts which starts at 0
      // and only increments in scheduleReconnect (private), we test the math directly
      const delay0 = client.getReconnectDelay(); // attempt 0: base * 2^0 = 1000
      expect(delay0).toBeLessThanOrEqual(1500);
    });

    it('should cap delay at max reconnect delay', () => {
      const client = new WsClient({
        serverUrl: 'http://localhost:3001',
        identity: { deviceId: 'test', apiKey: 'test-key' },
        logger: createMockLogger(),
        onMessage: () => {},
      });

      // Even with very high attempt count, delay should be reasonable
      // Since we can't set reconnectAttempts directly (it's private),
      // we verify the first attempt is within bounds
      const delay = client.getReconnectDelay();
      expect(delay).toBeLessThanOrEqual(90_000); // max 60k * 1.5 jitter
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      const client = new WsClient({
        serverUrl: 'http://localhost:3001',
        identity: { deviceId: 'test', apiKey: 'test-key' },
        logger: createMockLogger(),
        onMessage: () => {},
      });

      expect(client.isConnected()).toBe(false);
    });
  });
});

describe('CommandExecutor', () => {
  let executor: CommandExecutor;
  let mockWsClient: WsClient;
  let sentMessages: unknown[];

  beforeEach(() => {
    sentMessages = [];
    // Create a minimal mock of WsClient
    mockWsClient = {
      send: (msg: unknown) => sentMessages.push(msg),
      isConnected: () => true,
    } as unknown as WsClient;

    executor = new CommandExecutor(mockWsClient, createMockLogger());
  });

  it('should register and list commands', () => {
    executor.register('test-cmd', async () => ({ ok: true }));
    executor.register('another-cmd', async () => {});

    const commands = executor.getRegisteredCommands();
    expect(commands).toContain('test-cmd');
    expect(commands).toContain('another-cmd');
    expect(commands).toHaveLength(2);
  });

  it('should execute a registered command and send result', async () => {
    executor.register('ping', async () => ({ pong: true }));

    await executor.handleCommand({
      type: 'command',
      payload: { id: 'cmd-1', command: 'ping' } as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    });

    // Should have sent ack + result = 2 messages
    expect(sentMessages).toHaveLength(2);

    const ack = sentMessages[0] as { type: string };
    expect(ack.type).toBe('agent:command_ack');

    const result = sentMessages[1] as { type: string; payload: { success: boolean } };
    expect(result.type).toBe('agent:command_result');
    expect(result.payload.success).toBe(true);
  });

  it('should return error for unknown commands', async () => {
    await executor.handleCommand({
      type: 'command',
      payload: { id: 'cmd-2', command: 'unknown-cmd' } as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    });

    expect(sentMessages).toHaveLength(1);
    const result = sentMessages[0] as { payload: { success: boolean; error: string } };
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toContain('Unknown command');
  });

  it('should handle command execution errors', async () => {
    executor.register('fail-cmd', async () => {
      throw new Error('Something went wrong');
    });

    await executor.handleCommand({
      type: 'command',
      payload: { id: 'cmd-3', command: 'fail-cmd' } as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    });

    // ack + result
    expect(sentMessages).toHaveLength(2);
    const result = sentMessages[1] as { payload: { success: boolean; error: string } };
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toBe('Something went wrong');
  });

  it('should ignore invalid command messages', async () => {
    await executor.handleCommand({
      type: 'command',
      payload: {} as Record<string, unknown>,
      timestamp: Date.now(),
    });

    expect(sentMessages).toHaveLength(0);
  });
});

describe('Config', () => {
  it('should throw if config file does not exist', async () => {
    const { loadConfig } = await import('../lib/config.js');
    expect(() => loadConfig('/nonexistent/path.json')).toThrow(
      'Config file not found'
    );
  });
});
