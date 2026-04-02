#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { networkInterfaces } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output, cwd, platform, exit } from 'process';

const DEFAULT_SERVER = 'http://192.168.1.100:3401';
const INSTALL_CONFIG_PATH = 'C:\\Program Files\\Lightman\\Agent\\agent.config.json';

function printUsage() {
  console.log(`
cms-agent <command> [options]

Commands:
  install             Prompt slug, install agent with ShellReplace, reboot
  setup               Alias of install
  update              Reinstall/update using installed config, reboot

Options:
  --slug <value>      Device slug (example: C-AV01)
  --server <url>      Server URL (example: http://192.168.1.100:3401)
  --timezone <tz>     Timezone override (default: Asia/Kolkata)
  --pair-timeout <s>  Wait time for pairing in seconds (default: 900, 0 = no timeout)
  --no-restart        Skip reboot after successful install/update
  -h, --help          Show help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('-')) {
      continue;
    }
    if (part === '--no-restart') {
      args.noRestart = true;
      continue;
    }
    if (part === '--help' || part === '-h') {
      args.help = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('-')) {
      continue;
    }
    if (part === '--slug') {
      args.slug = next.trim();
      i += 1;
    } else if (part === '--server') {
      args.server = next.trim();
      i += 1;
    } else if (part === '--timezone') {
      args.timezone = next.trim();
      i += 1;
    } else if (part === '--pair-timeout') {
      args.pairTimeout = next.trim();
      i += 1;
    }
  }
  return args;
}

function safeReadJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isValidSlug(slug) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(slug);
}

function collectMacAddresses() {
  const nets = networkInterfaces();
  const macs = new Set();
  for (const netName of Object.keys(nets)) {
    const ifaceList = nets[netName] || [];
    for (const iface of ifaceList) {
      const mac = (iface.mac || '').trim().toUpperCase();
      if (!iface.internal && mac && mac !== '00:00:00:00:00:00') {
        macs.add(`${netName}: ${mac}`);
      }
    }
  }
  return [...macs];
}

function isWindowsAdmin() {
  const cmd = '[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().toLowerCase() === 'true';
}

function runOrFail(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`);
  }
}

async function promptSlug(defaultSlug) {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const prompt = defaultSlug
        ? `Enter device slug [${defaultSlug}]: `
        : 'Enter device slug (example C-AV01): ';
      const answer = (await rl.question(prompt)).trim();
      const slug = answer || defaultSlug || '';
      if (isValidSlug(slug)) {
        return slug;
      }
      console.error('Invalid slug. Use letters, numbers, and hyphens only.');
    }
  } finally {
    rl.close();
  }
}

function resolveInstallScript() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, '../scripts/install-windows.ps1');
  const localRepo = resolve(cwd(), 'scripts/install-windows.ps1');
  if (existsSync(packaged)) return packaged;
  if (existsSync(localRepo)) return localRepo;
  throw new Error('install-windows.ps1 not found. Expected in package scripts/ or current folder scripts/.');
}

function installUsingPowerShell({ scriptPath, slug, server, timezone, pairingTimeoutSeconds, noRestart }) {
  console.log(`powershell -ExecutionPolicy Bypass -File scripts\\install-windows.ps1 -Slug "${slug}" -Server "${server}" -ShellReplace`);
  const args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Slug', slug, '-Server', server, '-ShellReplace'];
  if (timezone) {
    args.push('-Timezone', timezone);
  }
  if (Number.isInteger(pairingTimeoutSeconds) && pairingTimeoutSeconds >= 0) {
    args.push('-PairingTimeoutSeconds', String(pairingTimeoutSeconds));
  }
  runOrFail('powershell.exe', args);

  if (!noRestart) {
    console.log('Installation completed. Rebooting now...');
    runOrFail('shutdown.exe', ['/r', '/t', '0', '/c', 'CMS Agent installation complete']);
  }
}

async function runInstall(opts) {
  if (platform !== 'win32') {
    throw new Error('cms-agent install is currently supported on Windows only.');
  }
  if (!isWindowsAdmin()) {
    throw new Error('Please run this command from an Administrator PowerShell or CMD.');
  }

  const localConfig = safeReadJson(resolve(cwd(), 'agent.config.json')) || {};
  const installedConfig = safeReadJson(INSTALL_CONFIG_PATH) || {};
  const defaultSlug = opts.slug || localConfig.deviceSlug || installedConfig.deviceSlug || '';
  const server = opts.server || DEFAULT_SERVER;
  const timezone = opts.timezone || localConfig?.powerSchedule?.timezone || installedConfig?.powerSchedule?.timezone || 'Asia/Kolkata';
  const pairingTimeoutSeconds = Number.isFinite(Number(opts.pairTimeout)) ? Number.parseInt(String(opts.pairTimeout), 10) : 900;
  const noRestart = Boolean(opts.noRestart);

  console.log('Detected MAC addresses:');
  const macs = collectMacAddresses();
  if (macs.length === 0) {
    console.log('  (no active external interface found)');
  } else {
    for (const item of macs) {
      console.log(`  ${item}`);
    }
  }
  console.log('');

  const slug = opts.slug || await promptSlug(defaultSlug);
  const scriptPath = resolveInstallScript();

  console.log(`Installing with slug=${slug}, server=${server}, shellReplace=true`);
  installUsingPowerShell({ scriptPath, slug, server, timezone, pairingTimeoutSeconds, noRestart });
}

async function runUpdate(opts) {
  if (platform !== 'win32') {
    throw new Error('cms-agent update is currently supported on Windows only.');
  }
  if (!isWindowsAdmin()) {
    throw new Error('Please run this command from an Administrator PowerShell or CMD.');
  }

  const installedConfig = safeReadJson(INSTALL_CONFIG_PATH) || {};
  const slug = opts.slug || installedConfig.deviceSlug;
  const server = opts.server || DEFAULT_SERVER;
  const timezone = opts.timezone || installedConfig?.powerSchedule?.timezone || 'Asia/Kolkata';
  const pairingTimeoutSeconds = Number.isFinite(Number(opts.pairTimeout)) ? Number.parseInt(String(opts.pairTimeout), 10) : 900;
  const noRestart = Boolean(opts.noRestart);
  const scriptPath = resolveInstallScript();

  if (!slug) {
    throw new Error('No installed slug found. Use cms-agent install first or pass --slug.');
  }

  console.log(`Updating with slug=${slug}, server=${server}, shellReplace=true`);
  installUsingPowerShell({ scriptPath, slug, server, timezone, pairingTimeoutSeconds, noRestart });
}

async function main() {
  const [, , commandRaw, ...rest] = process.argv;
  const command = commandRaw || '';
  const opts = parseArgs(rest);

  if (!command || opts.help || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'install' || command === 'setup') {
    await runInstall(opts);
    return;
  }
  if (command === 'update') {
    await runUpdate(opts);
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  exit(1);
});
