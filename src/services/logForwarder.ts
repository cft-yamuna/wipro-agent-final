import type { WsClient } from './websocket.js';
import type { Logger } from '../lib/logger.js';
import type { LogEntry, WsMessage } from '../lib/types.js';

interface LogForwarderConfig {
  batchIntervalMs: number;
  maxBatchSize: number;
}

const DEFAULT_CONFIG: LogForwarderConfig = {
  batchIntervalMs: 30_000,
  maxBatchSize: 100,
};

export class LogForwarder {
  private wsClient: WsClient;
  private logger: Logger;
  private config: LogForwarderConfig;
  private buffer: LogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(wsClient: WsClient, logger: Logger, config?: Partial<LogForwarderConfig>) {
    this.wsClient = wsClient;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  onLog(entry: LogEntry): void {
    this.buffer = [...this.buffer, entry];
    // Flush if buffer exceeds max batch size
    if (this.buffer.length >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  start(): void {
    if (this.timer !== null) {
      this.logger.warn('Log forwarder already running, ignoring duplicate start()');
      return;
    }
    this.timer = setInterval(() => {
      this.flush();
    }, this.config.batchIntervalMs);
    this.logger.info(`Log forwarder started (interval: ${this.config.batchIntervalMs}ms, maxBatch: ${this.config.maxBatchSize})`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final flush
    this.flush();
    this.logger.info('Log forwarder stopped');
  }

  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }

    const entries = this.buffer;
    this.buffer = [];

    const msg: WsMessage = {
      type: 'agent:logs',
      payload: { entries: entries as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    };
    this.wsClient.send(msg);
  }
}
