import { execSync, spawn, type ChildProcess } from 'child_process';
import { platform } from 'os';
import { createReadStream } from 'fs';
import type { WsClient } from './websocket.js';
import type { Logger } from '../lib/logger.js';

/**
 * SerialBridge — reads raw characters from a COM/serial port and converts them
 * to hardware events (monophone:pickup, monophone:hangup, button:press).
 *
 * Character mapping:
 *   * (asterisk)  → monophone:pickup   (handset lifted)
 *   # (hash)      → monophone:hangup   (handset replaced)
 *   1-9           → button:press with buttonId 1-9
 *
 * Events are forwarded to the server via WebSocket as `serial-bridge:event`.
 * The server then publishes them to MQTT so the display app receives them.
 *
 * Uses PowerShell on Windows / raw file read on Linux — NO native npm dependencies.
 */
export class SerialBridge {
  private wsClient: WsClient;
  private logger: Logger;
  private port: string;
  private baudRate: number;
  private controllerId: string;
  private running = false;
  private reader: ReturnType<typeof setInterval> | null = null;
  private buffer = '';
  private onEvent?: (event: Record<string, unknown>) => void;

  // Windows-specific: PowerShell process for reading serial
  private psProcess: ChildProcess | null = null;

  constructor(opts: {
    wsClient: WsClient;
    logger: Logger;
    port: string;
    baudRate?: number;
    controllerId: string;
    onEvent?: (event: Record<string, unknown>) => void;
  }) {
    this.wsClient = opts.wsClient;
    this.logger = opts.logger;
    this.port = opts.port;
    this.baudRate = opts.baudRate || 115200;
    this.controllerId = opts.controllerId;
    this.onEvent = opts.onEvent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.logger.info(`Serial bridge starting: ${this.port} @ ${this.baudRate} baud → controllerId: ${this.controllerId}`);

    const os = platform();
    if (os === 'win32') {
      this.startWindows();
    } else {
      this.startLinux();
    }
  }

  stop(): void {
    this.running = false;

    if (this.psProcess) {
      try { this.psProcess.kill(); } catch { /* ignore */ }
      this.psProcess = null;
    }

    if (this.reader) {
      clearInterval(this.reader);
      this.reader = null;
    }

    this.logger.info(`Serial bridge stopped: ${this.port}`);
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Windows: Use PowerShell to open the COM port and stream data line by line.
   * This avoids needing the `serialport` npm package.
   */
  private startWindows(): void {
    // PowerShell script that opens COM port and writes each received char to stdout
    const psScript = `
$port = New-Object System.IO.Ports.SerialPort '${this.port}', ${this.baudRate}, 'None', 8, 'One'
$port.ReadTimeout = 1000
$port.DtrEnable = $true
$port.RtsEnable = $true
try {
  $port.Open()
  [Console]::Out.WriteLine("SERIAL_BRIDGE_READY")
  while ($true) {
    try {
      $char = [char]$port.ReadChar()
      [Console]::Out.Write($char)
      [Console]::Out.Flush()
    } catch [System.TimeoutException] {
      # Read timeout, just loop
    }
  }
} catch {
  [Console]::Error.WriteLine("SERIAL_ERROR: $_")
} finally {
  if ($port.IsOpen) { $port.Close() }
}
`;

    this.psProcess = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.psProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Check for ready signal
      if (text.includes('SERIAL_BRIDGE_READY')) {
        this.logger.info(`Serial bridge connected to ${this.port}`);
        // Remove the ready signal from the text before processing
        const cleaned = text.replace('SERIAL_BRIDGE_READY', '').replace(/[\r\n]/g, '');
        if (cleaned) this.processChars(cleaned);
        return;
      }

      this.processChars(text);
    });

    this.psProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.logger.error(`Serial bridge error: ${msg}`);
      }
    });

    this.psProcess.on('exit', (code: number | null) => {
      this.logger.warn(`Serial bridge PowerShell exited with code ${code}`);
      if (this.running) {
        // Auto-restart after 3 seconds
        this.logger.info('Serial bridge will restart in 3s...');
        setTimeout(() => {
          if (this.running) this.startWindows();
        }, 3000);
      }
    });
  }

  /**
   * Linux: Read directly from /dev/ttyUSBx or /dev/ttyACMx.
   * Configure baud rate with stty first.
   */
  private startLinux(): void {
    try {
      execSync(`stty -F ${this.port} ${this.baudRate} raw -echo`, { timeout: 5000 });
    } catch (err) {
      this.logger.error(`Failed to configure serial port ${this.port}:`, err);
      return;
    }

    this.logger.info(`Serial bridge connected to ${this.port}`);

    const stream = createReadStream(this.port, { encoding: 'utf-8' });

    stream.on('data', (chunk: string | Buffer) => {
      this.processChars(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    });

    stream.on('error', (err: Error) => {
      this.logger.error(`Serial bridge read error: ${err.message}`);
      if (this.running) {
        this.logger.info('Serial bridge will restart in 3s...');
        setTimeout(() => {
          if (this.running) this.startLinux();
        }, 3000);
      }
    });

    stream.on('close', () => {
      this.logger.warn('Serial bridge stream closed');
    });
  }

  /**
   * Process received characters and emit hardware events.
   *
   *   *  → monophone:pickup
   *   #  → monophone:hangup
   *   1-9 → button:press (buttonId = digit)
   */
  private processChars(text: string): void {
    for (const char of text) {
      if (char === '*') {
        this.emitEvent('monophone:pickup');
      } else if (char === '#') {
        this.emitEvent('monophone:hangup');
      } else if (char >= '1' && char <= '9') {
        this.emitEvent('button:press', parseInt(char, 10));
      }
      // Ignore all other characters (newlines, spaces, noise)
    }
  }

  private emitEvent(type: string, buttonId?: number): void {
    const event: Record<string, unknown> = {
      type,
      controllerId: this.controllerId,
      timestamp: Date.now(),
    };
    if (buttonId !== undefined) {
      event.buttonId = buttonId;
    }

    this.logger.info(`Serial bridge event: ${type}${buttonId !== undefined ? ` buttonId=${buttonId}` : ''} (${this.port} → ${this.controllerId})`);

    // Send to server (for admin UI, MQTT, etc.)
    this.wsClient.send({
      type: 'serial-bridge:event',
      payload: event,
      timestamp: Date.now(),
    });

    // Broadcast locally to Chrome display directly
    this.onEvent?.(event);
  }
}
