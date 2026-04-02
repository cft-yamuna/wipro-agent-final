import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { resolve } from 'path';
import type { Logger } from '../lib/logger.js';

interface ManagedService {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  port: number;
  process: ChildProcess | null;
}

export class ServiceLauncher {
  private services: ManagedService[] = [];
  private logger: Logger;
  private projectRoot: string;

  constructor(logger: Logger, projectRoot: string) {
    this.logger = logger;
    this.projectRoot = projectRoot;
  }

  /**
   * Kill any existing processes on managed ports, then start fresh.
   */
  async startAll(): Promise<void> {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    this.services = [
      {
        name: 'server',
        cwd: resolve(this.projectRoot, 'server'),
        command: npmCmd,
        args: ['run', 'dev'],
        port: 3401,
        process: null,
      },
      {
        name: 'display',
        cwd: resolve(this.projectRoot, 'display'),
        command: npmCmd,
        args: ['run', 'dev'],
        port: 3403,
        process: null,
      },
    ];

    // Kill anything already on these ports for a clean start
    for (const svc of this.services) {
      await this.killProcessOnPort(svc.port);
    }

    // Small delay to let ports free up
    await new Promise((r) => setTimeout(r, 1_000));

    for (const svc of this.services) {
      this.logger.info(`Starting ${svc.name} (port ${svc.port})...`);
      svc.process = spawn(svc.command, svc.args, {
        cwd: svc.cwd,
        stdio: 'pipe',
        detached: false,
        shell: true,
      });

      svc.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().trim();
        if (lines) this.logger.debug(`[${svc.name}] ${lines}`);
      });

      svc.process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().trim();
        if (lines) this.logger.debug(`[${svc.name}:err] ${lines}`);
      });

      svc.process.on('exit', (code) => {
        this.logger.warn(`${svc.name} exited with code ${code}`);
        svc.process = null;
      });

      svc.process.on('error', (err) => {
        this.logger.error(`${svc.name} spawn error: ${err.message}`);
        svc.process = null;
      });
    }

    // Wait for each service to become reachable
    for (const svc of this.services) {
      await this.waitForPort(svc.name, svc.port, 60_000);
    }

    this.logger.info('All services started successfully');
  }

  /**
   * Stop all managed services.
   */
  stopAll(): void {
    for (const svc of this.services) {
      if (svc.process) {
        this.logger.info(`Stopping ${svc.name} (pid ${svc.process.pid})...`);
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(svc.process.pid), '/T', '/F'], {
              stdio: 'ignore',
              shell: true,
            });
          } else {
            svc.process.kill('SIGTERM');
          }
        } catch {
          // already dead
        }
        svc.process = null;
      }
    }
  }

  isRunning(name: string): boolean {
    const svc = this.services.find((s) => s.name === name);
    return svc?.process !== null && svc?.process?.exitCode === null;
  }

  private async killProcessOnPort(port: number): Promise<void> {
    try {
      if (process.platform === 'win32') {
        // Find PID using the port on Windows
        const result = execSync(
          `netstat -ano | findstr :${port} | findstr LISTENING`,
          { encoding: 'utf-8', timeout: 5_000 }
        ).trim();
        const lines = result.split('\n');
        const pids = new Set<string>();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') pids.add(pid);
        }
        for (const pid of pids) {
          this.logger.info(`Killing existing process on port ${port} (pid ${pid})`);
          try {
            execSync(`taskkill /pid ${pid} /T /F`, { timeout: 5_000 });
          } catch {
            // process may already be gone
          }
        }
      } else {
        // Unix: use fuser or lsof
        try {
          execSync(`fuser -k ${port}/tcp`, { timeout: 5_000 });
          this.logger.info(`Killed existing process on port ${port}`);
        } catch {
          // no process on port, that's fine
        }
      }
    } catch {
      // No process found on port — that's fine
    }
  }

  private async waitForPort(name: string, port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const interval = 1_500;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status > 0) {
          this.logger.info(`${name} is ready on port ${port}`);
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    this.logger.warn(`${name} did not become ready on port ${port} within ${timeoutMs}ms, continuing anyway`);
  }
}
