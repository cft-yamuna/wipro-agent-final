/**
 * Serial Port Test — Run this to check if your hardware is sending data.
 *
 * Usage:
 *   npx tsx test-serial.ts COM3
 *   npx tsx test-serial.ts COM3 115200
 *
 * What it does:
 *   Opens the COM port and prints every character received.
 *   Shows what event each character would trigger:
 *     * → monophone:pickup
 *     # → monophone:hangup
 *     1-9 → button:press
 *
 * Press Ctrl+C to stop.
 */

import { platform } from 'os';
import { spawn, execSync } from 'child_process';
import { createReadStream } from 'fs';

const port = process.argv[2];
const baudRate = parseInt(process.argv[3] || '115200', 10);

function logChar(char: string, count: number): void {
  const hex = char.charCodeAt(0).toString(16).padStart(2, '0');
  const time = new Date().toISOString().slice(11, 23);

  if (char === '*') {
    console.log(`[${time}] #${count}  char='*'  hex=0x${hex}  → MONOPHONE:PICKUP`);
  } else if (char === '#') {
    console.log(`[${time}] #${count}  char='#'  hex=0x${hex}  → MONOPHONE:HANGUP`);
  } else if (char >= '1' && char <= '9') {
    console.log(`[${time}] #${count}  char='${char}'  hex=0x${hex}  → BUTTON:PRESS id=${char}`);
  } else if (char === '\r' || char === '\n') {
    // skip newlines silently
  } else {
    console.log(`[${time}] #${count}  char='${char.replace(/[^\x20-\x7e]/g, '?')}'  hex=0x${hex}  (no mapping)`);
  }
}

if (!port) {
  console.log('Usage: npx tsx test-serial.ts <COM_PORT> [BAUD_RATE]');
  console.log('  Example: npx tsx test-serial.ts COM3');
  console.log('  Example: npx tsx test-serial.ts COM3 115200');
  process.exit(0);
} else {
  console.log('========================================');
  console.log(`  Serial Port Test`);
  console.log(`  Port: ${port}  Baud: ${baudRate}`);
  console.log('========================================');
  console.log('');
  console.log('Waiting for data from hardware...');
  console.log('  * → monophone:pickup');
  console.log('  # → monophone:hangup');
  console.log('  1-9 → button:press');
  console.log('  (any other char will show as raw hex)');
  console.log('');
  console.log('Press Ctrl+C to stop.');
  console.log('----------------------------------------');

  const os = platform();
  let count = 0;

  if (os === 'win32') {
    const psScript = `
$port = New-Object System.IO.Ports.SerialPort '${port}', ${baudRate}, 'None', 8, 'One'
$port.ReadTimeout = 1000
$port.DtrEnable = $true
$port.RtsEnable = $true
try {
  $port.Open()
  [Console]::Error.WriteLine("PORT_OPEN")
  while ($true) {
    try {
      $byte = $port.ReadByte()
      $char = [char]$byte
      [Console]::Out.Write($char)
      [Console]::Out.Flush()
    } catch [System.TimeoutException] {
      # timeout, keep looping
    }
  }
} catch {
  [Console]::Error.WriteLine("ERROR: $_")
} finally {
  if ($port.IsOpen) { $port.Close() }
}
`;

    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ps.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg === 'PORT_OPEN') {
        console.log(`[OK] Port ${port} opened successfully at ${baudRate} baud`);
        console.log('');
      } else if (msg.startsWith('ERROR:')) {
        console.error(`[FAIL] ${msg}`);
        console.error('');
        console.error('Common fixes:');
        console.error('  - Is the hardware plugged in?');
        console.error('  - Is another program using this port? (close Arduino IDE, PuTTY, etc.)');
        console.error(`  - Is ${port} the correct port? Run without args to list ports.`);
      }
    });

    ps.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const char of text) {
        count++;
        logChar(char, count);
      }
    });

    ps.on('exit', (code: number | null) => {
      console.log(`\nPowerShell exited (code ${code})`);
      process.exit(code || 0);
    });

    process.on('SIGINT', () => {
      console.log('\nStopping...');
      ps.kill();
      process.exit(0);
    });

  } else {
    // Linux
    try {
      execSync(`stty -F ${port} ${baudRate} raw -echo`, { timeout: 5000 });
      console.log(`[OK] Port ${port} configured at ${baudRate} baud`);
      console.log('');
    } catch (err: unknown) {
      console.error(`[FAIL] Could not configure ${port}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const stream = createReadStream(port, { encoding: 'utf-8' });

    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (const char of text) {
        count++;
        logChar(char, count);
      }
    });

    stream.on('error', (err: Error) => {
      console.error(`[FAIL] Read error: ${err.message}`);
      process.exit(1);
    });

    process.on('SIGINT', () => {
      console.log('\nStopping...');
      stream.destroy();
      process.exit(0);
    });
  }
}
