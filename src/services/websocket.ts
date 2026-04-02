import WebSocket from 'ws';
import type { WsMessage, Identity } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';

interface WsClientOptions {
  serverUrl: string;
  identity: Identity;
  logger: Logger;
  onMessage: (msg: WsMessage) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private identity: Identity;
  private logger: Logger;
  private onMessage: (msg: WsMessage) => void;

  private reconnectAttempts = 0;
  private maxReconnectDelay = 60_000;
  private baseDelay = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private messageQueue: WsMessage[] = [];

  constructor(options: WsClientOptions) {
    this.serverUrl = options.serverUrl;
    this.identity = options.identity;
    this.logger = options.logger;
    this.onMessage = options.onMessage;
  }

  connect(): void {
    if (this.closed) return;

    const wsUrl = this.serverUrl.replace(/^http/, 'ws') +
      '/ws/agent?apiKey=' + encodeURIComponent(this.identity.apiKey);

    this.logger.debug('Connecting to', wsUrl.replace(/apiKey=.*/, 'apiKey=***'));

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.logger.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.flushQueue();
    });

    this.ws.on('message', (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        this.onMessage(msg);
      } catch (err) {
        this.logger.error('Failed to parse WS message:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`);
      this.ws = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error('WebSocket error:', err);
      // 'close' event will fire after this, triggering reconnect
    });

    this.ws.on('ping', () => {
      // ws library auto-responds with pong
    });
  }

  send(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Queue message for when connection is restored
      this.messageQueue.push(msg);
      // Keep queue bounded
      if (this.messageQueue.length > 100) {
        this.messageQueue.shift();
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
    this.messageQueue = [];
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Calculate delay with exponential backoff + jitter */
  getReconnectDelay(): number {
    const exponential = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    const capped = Math.min(exponential, this.maxReconnectDelay);
    // Add jitter: 0.5x to 1.5x
    const jitter = capped * (0.5 + Math.random());
    return Math.round(jitter);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;

    this.logger.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const MAX_AGE = 300_000; // 5 minutes

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      if (now - msg.timestamp > MAX_AGE) {
        this.logger.warn(`Discarding stale queued message: ${msg.type}`);
        continue;
      }
      this.ws.send(JSON.stringify(msg));
    }
  }
}
