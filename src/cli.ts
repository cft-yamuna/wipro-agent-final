#!/usr/bin/env node
/**
 * lightman-agent CLI
 *
 * Usage:
 *   npm install -g lightman-agent
 *   lightman-agent install --slug F-AV01 --server http://192.168.1.54:3401
 *   lightman-agent install --slug F-AV01 --server http://... --shell-replace
 *   lightman-agent start
 *   lightman-agent stop
 *   lightman-agent status
 *   lightman-agent update
 *   lightman-agent uninstall
 *   lightman-agent version
 */

import { execSync, execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = resolve(PACKAGE_ROOT, 'scripts');
const IS_WINDOWS = platform() === 'win32';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function run(cmd: string, opts?: { cwd?: string }): void {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: opts?.cwd || PACKAGE_ROOT });
  } catch (err) {
    process.exit(1);
  }
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        i++;
      }
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`
  lightman-agent v${getVersion()}

  Usage:
    lightman-agent <command> [options]

  Commands:
    install    Install as a system service
    start      Start the agent service
    stop       Stop the agent service
    status     Show agent service status
    update     Pull latest and rebuild
    uninstall  Remove the agent service
    version    Show version info

  Install options:
    --slug <device-slug>     Device slug (required)
    --server <url>           Server URL (required)
    --timezone <tz>          Timezone (default: Asia/Kolkata)
    --shell-replace          Enable shell replacement mode (Windows kiosk)

  Examples:
    lightman-agent install --slug F-AV01 --server http://192.168.1.54:3401
    lightman-agent install --slug F-AV01 --server http://... --shell-replace
    lightman-agent start
`);
}

// ── Commands ──

function cmdInstall(args: Record<string, string | boolean>): void {
  const slug = args['slug'] as string;
  const server = args['server'] as string;
  const timezone = (args['timezone'] as string) || 'Asia/Kolkata';
  const shellReplace = !!args['shell-replace'];

  if (!slug || !server) {
    console.error('Error: --slug and --server are required');
    console.error('  lightman-agent install --slug F-AV01 --server http://192.168.1.54:3401');
    process.exit(1);
  }

  console.log(`\n  LIGHTMAN Agent v${getVersion()}`);
  console.log(`  Device slug : ${slug}`);
  console.log(`  Server URL  : ${server}`);
  console.log(`  Timezone    : ${timezone}`);
  console.log(`  Shell mode  : ${shellReplace ? 'Yes' : 'No'}\n`);

  if (IS_WINDOWS) {
    const script = resolve(SCRIPTS_DIR, 'install-windows.ps1');
    if (!existsSync(script)) {
      console.error(`Install script not found: ${script}`);
      process.exit(1);
    }
    const shellFlag = shellReplace ? ' -ShellReplace' : '';
    run(`powershell -ExecutionPolicy Bypass -File "${script}" -Slug "${slug}" -Server "${server}" -Timezone "${timezone}"${shellFlag}`);
  } else {
    const script = resolve(SCRIPTS_DIR, 'install-linux.sh');
    if (!existsSync(script)) {
      console.error(`Install script not found: ${script}`);
      process.exit(1);
    }
    run(`bash "${script}" --slug "${slug}" --server "${server}" --timezone "${timezone}"`);
  }
}

function cmdStart(): void {
  if (IS_WINDOWS) {
    console.log('Starting LightmanAgent service...');
    run('net start LightmanAgent');
  } else {
    console.log('Starting lightman-agent service...');
    run('sudo systemctl start lightman-agent');
  }
}

function cmdStop(): void {
  if (IS_WINDOWS) {
    console.log('Stopping LightmanAgent service...');
    run('net stop LightmanAgent');
  } else {
    console.log('Stopping lightman-agent service...');
    run('sudo systemctl stop lightman-agent');
  }
}

function cmdStatus(): void {
  if (IS_WINDOWS) {
    run('sc query LightmanAgent');
  } else {
    run('sudo systemctl status lightman-agent --no-pager');
  }
}

function cmdUninstall(): void {
  if (IS_WINDOWS) {
    const script = resolve(SCRIPTS_DIR, 'uninstall-windows.ps1');
    if (existsSync(script)) {
      run(`powershell -ExecutionPolicy Bypass -File "${script}"`);
    } else {
      console.error('Uninstall script not found');
      process.exit(1);
    }
  } else {
    const script = resolve(SCRIPTS_DIR, 'uninstall-linux.sh');
    if (existsSync(script)) {
      run(`bash "${script}"`);
    } else {
      console.error('Uninstall script not found');
      process.exit(1);
    }
  }
}

function cmdUpdate(): void {
  console.log('Updating lightman-agent to latest...');
  run('npm install -g lightman-agent@latest');
  console.log('Update complete. Restart the service to apply:');
  console.log('  lightman-agent stop && lightman-agent start');
}

function cmdVersion(): void {
  console.log(`lightman-agent v${getVersion()}`);
  console.log(`Platform: ${platform()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Package: ${PACKAGE_ROOT}`);
}

// ── Main ──

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
  case 'install':
    cmdInstall(args);
    break;
  case 'start':
    cmdStart();
    break;
  case 'stop':
    cmdStop();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'update':
    cmdUpdate();
    break;
  case 'uninstall':
    cmdUninstall();
    break;
  case 'version':
  case '-v':
  case '--version':
    cmdVersion();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
