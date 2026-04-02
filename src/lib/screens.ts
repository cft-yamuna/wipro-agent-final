import { execSync } from 'child_process';
import { getPlatform } from './platform.js';
import type { Logger } from './logger.js';

export interface DetectedScreen {
  /** Windows display device ID, e.g. "\\.\DISPLAY1" */
  hardwareId: string;
  /** Friendly name / adapter description */
  name: string;
  /** Display index (0-based) */
  index: number;
  /** Screen bounds */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Whether this is the primary monitor */
  primary: boolean;
}

/**
 * Detect all connected displays on this machine.
 * Windows: uses PowerShell + CIM to get monitor positions and IDs.
 * Linux/macOS: uses xrandr / system_profiler (basic fallback).
 */
export function detectScreens(logger: Logger): DetectedScreen[] {
  const platform = getPlatform();

  if (platform === 'windows') {
    return detectScreensWindows(logger);
  }

  if (platform === 'linux') {
    return detectScreensLinux(logger);
  }

  logger.warn('[Screens] Screen detection not supported on this platform');
  return [];
}

function detectScreensWindows(logger: Logger): DetectedScreen[] {
  try {
    // PowerShell script — use regular string to avoid JS template literal eating $variables
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$screens = [System.Windows.Forms.Screen]::AllScreens;',
      '$result = @();',
      '$i = 0;',
      'foreach ($s in $screens) {',
      '  $result += [PSCustomObject]@{',
      '    hardwareId = $s.DeviceName;',
      '    name = $s.DeviceName;',
      '    index = $i;',
      '    x = $s.Bounds.X;',
      '    y = $s.Bounds.Y;',
      '    width = $s.Bounds.Width;',
      '    height = $s.Bounds.Height;',
      '    primary = $s.Primary',
      '  };',
      '  $i++',
      '};',
      '$result | ConvertTo-Json -Compress',
    ].join(' ');

    const result = execSync('powershell -NoProfile -Command "' + psScript + '"', {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!result) {
      logger.warn('[Screens] PowerShell returned empty result');
      return [];
    }

    // PowerShell returns a single object (not array) when there's only 1 screen
    const parsed = JSON.parse(result);
    const screens: DetectedScreen[] = Array.isArray(parsed) ? parsed : [parsed];

    logger.info(`[Screens] Detected ${screens.length} display(s)`);
    for (const s of screens) {
      logger.debug(`[Screens]   ${s.hardwareId} — ${s.width}x${s.height} @ (${s.x},${s.y})${s.primary ? ' [PRIMARY]' : ''}`);
    }

    return screens;
  } catch (err) {
    logger.error('[Screens] Failed to detect screens on Windows:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

function detectScreensLinux(logger: Logger): DetectedScreen[] {
  try {
    const result = execSync('xrandr --query', {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const screens: DetectedScreen[] = [];
    const lines = result.split('\n');
    let index = 0;

    for (const line of lines) {
      // Match lines like: "HDMI-1 connected primary 1920x1080+0+0"
      const match = line.match(/^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/);
      if (match) {
        screens.push({
          hardwareId: match[1],
          name: match[1],
          index,
          x: parseInt(match[5], 10),
          y: parseInt(match[6], 10),
          width: parseInt(match[3], 10),
          height: parseInt(match[4], 10),
          primary: !!match[2],
        });
        index++;
      }
    }

    logger.info(`[Screens] Detected ${screens.length} display(s) via xrandr`);
    return screens;
  } catch (err) {
    logger.error('[Screens] Failed to detect screens on Linux:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
