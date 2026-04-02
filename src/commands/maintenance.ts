import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { CommandHandler } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';
import type { Watchdog } from '../services/watchdog.js';

export function registerMaintenanceCommands(
  register: (command: string, handler: CommandHandler) => void,
  watchdog: Watchdog,
  logger: Logger
): void {
  // maintenance:cleanup — Run disk cleanup immediately
  register('maintenance:cleanup', async () => {
    logger.info('Manual disk cleanup requested');
    const result = await watchdog.runDiskCleanup();
    return { ...result };
  });

  // maintenance:status — Get watchdog recovery stats
  register('maintenance:status', async () => {
    const stats = watchdog.getStats();
    const cooldowns = watchdog.getCooldowns();
    return { stats, cooldowns };
  });

  // maintenance:restore-desktop — Switch from shell replacement back to normal desktop
  // After this command, machine needs a reboot to take effect.
  register('maintenance:restore-desktop', async () => {
    if (process.platform !== 'win32') {
      return { restored: false, message: 'Only available on Windows' };
    }

    logger.warn('RESTORE DESKTOP: Switching Windows shell back to explorer.exe');

    try {
      // Restore HKLM shell to explorer.exe
      execSync(
        'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v Shell /d explorer.exe /f',
        { stdio: 'ignore', timeout: 10_000 }
      );
      // Remove HKCU shell override
      execSync(
        'reg delete "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v Shell /f',
        { stdio: 'ignore', timeout: 10_000 }
      );
    } catch {
      // HKCU key may not exist, that's fine
    }

    // Also set shellMode: false in the config so agent resumes normal kiosk management
    try {
      const configPath = resolve(process.cwd(), 'agent.config.json');
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.kiosk) {
        config.kiosk.shellMode = false;
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      logger.info('Config updated: shellMode set to false');
    } catch (err) {
      logger.error('Failed to update config:', err instanceof Error ? err.message : String(err));
    }

    logger.warn('Desktop restored. Machine needs a REBOOT to take effect.');
    return { restored: true, message: 'Desktop restored. Reboot required.' };
  });

  // maintenance:enable-shell — Switch from normal desktop to shell replacement mode
  // After this command, machine needs a reboot to take effect.
  register('maintenance:enable-shell', async () => {
    if (process.platform !== 'win32') {
      return { enabled: false, message: 'Only available on Windows' };
    }

    const shellBat = resolve(process.cwd(), 'lightman-shell.bat');
    logger.warn(`ENABLE SHELL: Switching Windows shell to ${shellBat}`);

    try {
      // Set shell to lightman-shell.bat
      execSync(
        `reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v Shell /d "\\"${shellBat}\\"" /f`,
        { stdio: 'ignore', timeout: 10_000 }
      );
    } catch (err) {
      return { enabled: false, message: `Registry update failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Update config to shellMode: true
    try {
      const configPath = resolve(process.cwd(), 'agent.config.json');
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.kiosk) {
        config.kiosk.shellMode = true;
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      logger.info('Config updated: shellMode set to true');
    } catch (err) {
      logger.error('Failed to update config:', err instanceof Error ? err.message : String(err));
    }

    logger.warn('Shell mode enabled. Machine needs a REBOOT to take effect.');
    return { enabled: true, message: 'Shell mode enabled. Reboot required.' };
  });
}
