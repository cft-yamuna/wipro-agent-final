import si from 'systeminformation';
import net from 'net';
import { URL } from 'url';
import type { HealthReport, WsMessage } from '../lib/types.js';
import type { WsClient } from './websocket.js';
import type { Logger } from '../lib/logger.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isRaspberryPi, getGpuTemp, getThrottled, isSdCardReadOnly } from '../lib/rpi.js';

export class HealthMonitor {
  private wsClient: WsClient;
  private logger: Logger;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private agentVersion: string;
  private serverUrl: string;

  constructor(wsClient: WsClient, logger: Logger, intervalMs: number, serverUrl?: string) {
    this.wsClient = wsClient;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.serverUrl = serverUrl || '';

    // Read version from package.json
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')
      );
      this.agentVersion = pkg.version || '0.0.0';
    } catch {
      this.agentVersion = '0.0.0';
    }
  }

  start(): void {
    this.logger.info(`Health monitor started (interval: ${this.intervalMs}ms)`);

    // Send initial report after a short delay
    setTimeout(() => {
      this.collectAndSend();
    }, 5_000);

    this.timer = setInterval(() => {
      this.collectAndSend();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Health monitor stopped');
  }

  async collect(): Promise<HealthReport> {
    const [cpu, mem, disk, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature(),
    ]);

    // Use the first/main disk
    const mainDisk = disk[0] || { size: 0, used: 0, use: 0 };

    const report: HealthReport = {
      cpuUsage: Math.round(cpu.currentLoad * 100) / 100,
      memTotal: mem.total,
      memUsed: mem.used,
      memPercent: mem.total > 0 ? Math.round((mem.used / mem.total) * 10000) / 100 : 0,
      diskTotal: mainDisk.size,
      diskUsed: mainDisk.used,
      diskPercent: Math.round(mainDisk.use * 100) / 100,
      cpuTemp: temp.main !== null ? Math.round(temp.main * 10) / 10 : null,
      uptime: Math.round(process.uptime()),
      agentVersion: this.agentVersion,
    };

    // Add RPi-specific fields when running on Raspberry Pi
    if (isRaspberryPi()) {
      report.gpuTemp = getGpuTemp();
      report.throttled = getThrottled();
      report.sdCardReadOnly = isSdCardReadOnly();
    }

    // Add network info
    try {
      const ifaces = await si.networkInterfaces();
      const ifaceList = Array.isArray(ifaces) ? ifaces : [ifaces];
      const primary = ifaceList.find((i) => !i.internal && i.ip4) || null;

      if (primary) {
        let serverLatencyMs: number | null = null;
        if (this.serverUrl) {
          try {
            const url = new URL(this.serverUrl);
            const host = url.hostname;
            const port = parseInt(url.port, 10) || 3001;
            const start = Date.now();
            const reachable = await this.tcpPing(host, port, 5000);
            serverLatencyMs = reachable ? Date.now() - start : null;
          } catch {
            // Ignore ping errors in health collection
          }
        }

        report.network = {
          interface: primary.iface,
          ip: primary.ip4,
          mac: primary.mac,
          serverLatencyMs,
        };
      }
    } catch {
      // Network info is optional, don't fail health collection
    }

    return report;
  }

  private tcpPing(host: string, port: number, timeoutMs: number): Promise<boolean> {
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

  private async collectAndSend(): Promise<void> {
    try {
      const report = await this.collect();
      const msg: WsMessage = {
        type: 'agent:health',
        payload: report as unknown as Record<string, unknown>,
        timestamp: Date.now(),
      };
      this.wsClient.send(msg);
      this.logger.debug('Health report sent', {
        cpu: report.cpuUsage,
        mem: report.memPercent,
        disk: report.diskPercent,
      });
    } catch (err) {
      this.logger.error('Failed to collect health data:', err);
    }
  }
}
