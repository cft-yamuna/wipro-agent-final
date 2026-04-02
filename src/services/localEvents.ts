import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from '../lib/logger.js';

/**
 * Local hardware event broadcaster.
 * Runs a WebSocket server on localhost only so the local Chrome display
 * can receive hardware events directly from the agent — no server round-trip.
 */
export class LocalEventServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private port: number;
  private logger: Logger;

  constructor(port: number, logger: Logger) {
    this.port = port;
    this.logger = logger;
  }

  start(): void {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      this.logger.debug(`[LocalEvents] Display connected (total: ${this.clients.size})`);

      ws.on('close', () => {
        this.clients.delete(ws);
        this.logger.debug(`[LocalEvents] Display disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (err) => {
      this.logger.error('[LocalEvents] Server error:', err);
    });

    this.logger.info(`[LocalEvents] Hardware event server listening on ws://127.0.0.1:${this.port}`);
  }

  broadcast(event: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
    this.logger.debug(`[LocalEvents] Broadcast to ${this.clients.size} client(s): ${event.type}`);
  }

  stop(): void {
    this.wss?.close();
    this.wss = null;
    this.clients.clear();
  }
}
