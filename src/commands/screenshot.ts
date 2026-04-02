import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { CommandHandler } from '../lib/types.js';
import type { Logger } from '../lib/logger.js';
import { getPlatform } from '../lib/platform.js';

const ALLOWED_CAPTURE_TOOLS = ['scrot', 'import', 'screencapture'] as const;

// --- Zod Schema ---
const ScreenshotArgsSchema = z.object({
  serverUrl: z.string().url().optional(),
  deviceId: z.string().uuid().optional(),
  apiKey: z.string().min(1).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

export function registerScreenshotCommands(
  register: (command: string, handler: CommandHandler) => void,
  logger: Logger
): void {
  register('kiosk:screenshot', async (args) => {
    const parsed = ScreenshotArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid screenshot args: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const { serverUrl, deviceId, apiKey, quality: parsedQuality } = parsed.data;
    const quality = parsedQuality ?? 75;

    const tmpFile = `/tmp/lightman-screenshot-${Date.now()}.jpg`;

    try {
      // --- Capture screenshot ---
      const { tool, toolArgs } = resolveCapture(quality, tmpFile);
      logger.info(`Capturing screenshot: ${tool} ${toolArgs.join(' ')}`);

      execFileSync(tool, toolArgs, { timeout: 10_000, stdio: 'pipe' });

      if (!fs.existsSync(tmpFile)) {
        throw new Error('Screenshot file was not created');
      }

      const buffer = await fs.promises.readFile(tmpFile);
      logger.info(`Screenshot captured: ${buffer.length} bytes`);

      // --- Upload if server info provided ---
      if (serverUrl && deviceId && apiKey) {
        try {
          const uploaded = await uploadScreenshot(
            buffer,
            tmpFile,
            serverUrl,
            deviceId,
            apiKey,
            logger
          );
          return { captured: true, size: buffer.length, uploaded };
        } catch (uploadErr) {
          const errMsg =
            uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          logger.error('Screenshot upload failed:', errMsg);
          return { captured: true, size: buffer.length, uploaded: false, error: errMsg };
        }
      }

      return { captured: true, size: buffer.length, uploaded: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Screenshot capture failed:', errMsg);
      throw new Error(`Screenshot capture failed: ${errMsg}`);
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tmpFile)) {
          await fs.promises.unlink(tmpFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  });
}

/**
 * Determine the capture tool and arguments based on platform.
 * No user-controlled command strings — only allowlisted tools with safe args.
 */
function resolveCapture(
  quality: number,
  tmpFile: string
): { tool: string; toolArgs: string[] } {
  const platform = getPlatform();

  if (platform === 'linux') {
    if (commandExists('scrot')) {
      return { tool: 'scrot', toolArgs: ['-q', String(quality), tmpFile] };
    }
    if (commandExists('import')) {
      return { tool: 'import', toolArgs: ['-window', 'root', '-quality', String(quality), tmpFile] };
    }
    throw new Error(
      'No screenshot tool available. Install scrot or ImageMagick (import).'
    );
  }

  if (platform === 'darwin') {
    return { tool: 'screencapture', toolArgs: ['-x', '-t', 'jpg', tmpFile] };
  }

  throw new Error(`Screenshot capture not supported on platform: ${platform}`);
}

/**
 * Check if a command exists on the system using execFileSync (no shell injection).
 */
function commandExists(cmd: string): boolean {
  if (!ALLOWED_CAPTURE_TOOLS.includes(cmd as typeof ALLOWED_CAPTURE_TOOLS[number])) {
    return false;
  }
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload screenshot to server via multipart/form-data.
 */
async function uploadScreenshot(
  buffer: Buffer,
  filePath: string,
  serverUrl: string,
  deviceId: string,
  apiKey: string,
  logger: Logger
): Promise<boolean> {
  const endpoint = `/api/devices/${deviceId}/screenshot`;
  const url = `${serverUrl}${endpoint}`;
  const filename = path.basename(filePath);

  logger.info(`Uploading screenshot to ${url}`);

  const blob = new Blob([buffer], { type: 'image/jpeg' });
  const formData = new FormData();
  formData.append('screenshot', blob, filename);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Upload failed: HTTP ${response.status} ${body}`);
  }

  logger.info('Screenshot uploaded successfully');
  return true;
}
