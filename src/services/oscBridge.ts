import { createSocket, type Socket } from 'dgram';
import type { WsClient } from './websocket.js';
import type { Logger } from '../lib/logger.js';

/**
 * OscBridge — listens for OSC messages over UDP and converts them to
 * hardware events, mirroring the SerialBridge pattern.
 *
 * When the configured OSC address is received with arg === 1, it emits
 * an `osc:trigger` event via the local event broadcaster and the server WS.
 *
 * Uses Node.js built-in `dgram` — no external dependencies.
 *
 * OSC wire format (minimal parser):
 *   - Address: null-terminated string padded to 4-byte boundary
 *   - Type tag: "," + type chars, null-terminated padded to 4-byte boundary
 *   - Arguments: int32 (big-endian) for 'i', float32 for 'f'
 */
export class OscBridge {
  private wsClient: WsClient;
  private logger: Logger;
  private port: number;
  private host: string;
  private address: string;
  private running = false;
  private socket: Socket | null = null;
  private onEvent?: (event: Record<string, unknown>) => void;

  constructor(opts: {
    wsClient: WsClient;
    logger: Logger;
    port: number;
    host?: string;
    address: string;
    onEvent?: (event: Record<string, unknown>) => void;
  }) {
    this.wsClient = opts.wsClient;
    this.logger = opts.logger;
    this.port = opts.port;
    this.host = opts.host || '0.0.0.0';
    this.address = opts.address;
    this.onEvent = opts.onEvent;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info(`[OSC] Starting bridge — listening on UDP ${this.host}:${this.port} for address "${this.address}"`);

    this.socket = createSocket('udp4');

    this.socket.on('message', (msg: Buffer) => {
      try {
        const parsed = parseOscMessage(msg);
        if (!parsed) return;

        this.logger.debug(`[OSC] Received: ${parsed.address} args=${JSON.stringify(parsed.args)}`);

        // Match address
        if (parsed.address === this.address) {
          const firstArg = parsed.args[0];
          // Trigger on arg === 1 (int or float)
          if (firstArg === 1 || firstArg === 1.0) {
            this.emitTrigger();
          }
        }
      } catch (err) {
        this.logger.debug('[OSC] Failed to parse message:', err);
      }
    });

    this.socket.on('error', (err) => {
      this.logger.error('[OSC] Socket error:', err);
      if (this.running) {
        this.socket?.close();
        this.socket = null;
        this.logger.info('[OSC] Restarting in 3s...');
        setTimeout(() => {
          if (this.running) this.start();
        }, 3000);
      }
    });

    this.socket.bind(this.port, this.host, () => {
      this.logger.info(`[OSC] Bridge listening on UDP ${this.host}:${this.port}`);
    });
  }

  stop(): void {
    this.running = false;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.logger.info('[OSC] Bridge stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private emitTrigger(): void {
    const event: Record<string, unknown> = {
      type: 'osc:trigger',
      address: this.address,
      timestamp: Date.now(),
    };

    this.logger.info(`[OSC] Trigger event: ${this.address}`);

    // Send to server
    this.wsClient.send({
      type: 'osc-bridge:event',
      payload: event,
      timestamp: Date.now(),
    });

    // Broadcast locally to Chrome display
    this.onEvent?.(event);
  }
}

// ==========================================
// Minimal OSC message parser
// ==========================================

interface OscMessage {
  address: string;
  args: (number | string)[];
}

function parseOscMessage(buf: Buffer): OscMessage | null {
  let offset = 0;

  // Read address string
  const address = readOscString(buf, offset);
  if (!address.value || address.value[0] !== '/') return null;
  offset = address.next;

  // Read type tag string
  const typeTags = readOscString(buf, offset);
  offset = typeTags.next;

  const tags = typeTags.value || '';
  // Type tag starts with ','
  const types = tags.startsWith(',') ? tags.slice(1) : tags;

  // Read arguments
  const args: (number | string)[] = [];
  for (const t of types) {
    if (offset >= buf.length) break;

    switch (t) {
      case 'i': // int32
        args.push(buf.readInt32BE(offset));
        offset += 4;
        break;
      case 'f': // float32
        args.push(buf.readFloatBE(offset));
        offset += 4;
        break;
      case 's': { // string
        const s = readOscString(buf, offset);
        args.push(s.value);
        offset = s.next;
        break;
      }
      default:
        // Unknown type, stop parsing
        return { address: address.value, args };
    }
  }

  return { address: address.value, args };
}

function readOscString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString('utf-8', offset, end);
  // OSC strings are padded to 4-byte boundary (including null terminator)
  const padded = end + 1;
  const next = padded + ((4 - (padded % 4)) % 4);
  return { value, next };
}
