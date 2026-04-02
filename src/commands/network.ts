import net from 'net';
import dns from 'dns';
import { URL } from 'url';
import si from 'systeminformation';
import type { CommandHandler } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';

export function registerNetworkCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger,
  serverUrl: string
): void {
  // network:ping — TCP connect to CMS server, measure round-trip
  register('network:ping', async () => {
    const url = new URL(serverUrl);
    const host = url.hostname;
    const port = parseInt(url.port, 10) || 3001;

    const start = Date.now();
    const reachable = await tcpPing(host, port, 5000);
    const latencyMs = Date.now() - start;

    logger.info(`Network ping: ${host}:${port} → ${reachable ? 'OK' : 'FAIL'} (${latencyMs}ms)`);
    return { latency_ms: latencyMs, reachable, host, port };
  });

  // network:bandwidth — Download 1MB test file, measure speed
  register('network:bandwidth', async () => {
    const url = `${serverUrl}/api/agent/bandwidth-test`;
    logger.info(`Bandwidth test: downloading from ${url}`);

    const start = Date.now();
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const durationMs = Date.now() - start;
      const sizeMb = buffer.byteLength / (1024 * 1024);
      const speedMbps = (sizeMb * 8) / (durationMs / 1000);

      logger.info(`Bandwidth: ${speedMbps.toFixed(2)} Mbps (${buffer.byteLength} bytes in ${durationMs}ms)`);
      return {
        speed_mbps: Math.round(speedMbps * 100) / 100,
        duration_ms: durationMs,
        bytes: buffer.byteLength,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Bandwidth test failed:', message);
      throw new Error(`Bandwidth test failed: ${message}`);
    }
  });

  // network:dns — Resolve CMS hostname
  register('network:dns', async () => {
    const url = new URL(serverUrl);
    const hostname = url.hostname;

    logger.info(`DNS resolve: ${hostname}`);
    const start = Date.now();

    try {
      const addresses = await new Promise<string[]>((resolve, reject) => {
        dns.resolve(hostname, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs);
        });
      });
      const timeMs = Date.now() - start;

      logger.info(`DNS resolved: ${hostname} → ${addresses.join(', ')} (${timeMs}ms)`);
      return { resolved: true, addresses, time_ms: timeMs, hostname };
    } catch (err) {
      const timeMs = Date.now() - start;
      // If it's an IP address, DNS resolve will fail — that's OK
      if (net.isIP(hostname)) {
        return { resolved: true, addresses: [hostname], time_ms: timeMs, hostname, note: 'IP address (no DNS needed)' };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('DNS resolve failed:', message);
      return { resolved: false, addresses: [], time_ms: timeMs, hostname, error: message };
    }
  });

  // network:interfaces — List network interfaces
  register('network:interfaces', async () => {
    const ifaces = await si.networkInterfaces();
    const ifaceList = Array.isArray(ifaces) ? ifaces : [ifaces];

    const interfaces = ifaceList
      .filter((iface) => !iface.internal && iface.ip4)
      .map((iface) => ({
        name: iface.iface,
        ip4: iface.ip4,
        mac: iface.mac,
        speed: iface.speed,
        type: iface.type,
      }));

    logger.info(`Network interfaces: ${interfaces.length} found`);
    return { interfaces };
  });
}

/**
 * TCP ping: attempt a TCP connection and measure latency.
 * Returns true if connection succeeds within timeout.
 */
function tcpPing(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, host);
  });
}
