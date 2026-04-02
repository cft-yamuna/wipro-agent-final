import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import type { AgentConfig } from './types.js';

const kioskSchema = z.object({
  browserPath: z.string().default('chromium-browser'),
  defaultUrl: z.string().url().default('http://localhost:3401/display'),
  extraArgs: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).default(10_000),
  maxCrashesInWindow: z.number().int().min(1).default(10),
  crashWindowMs: z.number().int().min(10_000).default(300_000),
  shellMode: z.boolean().default(false),
});

const screenshotSchema = z.object({
  captureCommand: z.string().default('scrot'),
  quality: z.number().int().min(1).max(100).default(80),
  uploadEndpoint: z.string().default('/api/devices/{deviceId}/screenshot'),
});

const powerScheduleSchema = z.object({
  shutdownCron: z.string().optional(),
  startupCron: z.string().optional(),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  shutdownWarningSeconds: z.number().int().min(0).max(600).default(60),
});

const configSchema = z.object({
  serverUrl: z.string().url(),
  deviceSlug: z.string().min(1),
  healthIntervalMs: z.number().int().min(5000).default(60000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logFile: z.string().default('agent.log'),
  identityFile: z.string().default('.lightman-identity.json'),
  localServices: z.boolean().default(true),
  kiosk: kioskSchema.optional(),
  screenshot: screenshotSchema.optional(),
  powerSchedule: powerScheduleSchema.optional(),
});

export function loadConfig(configPath?: string): AgentConfig {
  const filePath = configPath || resolve(process.cwd(), 'agent.config.json');

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Apply environment overrides
  const merged = {
    ...raw,
    ...(process.env.LIGHTMAN_SERVER_URL && { serverUrl: process.env.LIGHTMAN_SERVER_URL }),
    ...(process.env.LIGHTMAN_DEVICE_SLUG && { deviceSlug: process.env.LIGHTMAN_DEVICE_SLUG }),
    ...(process.env.LIGHTMAN_HEALTH_INTERVAL && { healthIntervalMs: parseInt(process.env.LIGHTMAN_HEALTH_INTERVAL, 10) }),
    ...(process.env.LIGHTMAN_LOG_LEVEL && { logLevel: process.env.LIGHTMAN_LOG_LEVEL }),
    ...(process.env.LIGHTMAN_LOG_FILE && { logFile: process.env.LIGHTMAN_LOG_FILE }),
    ...(process.env.LIGHTMAN_IDENTITY_FILE && { identityFile: process.env.LIGHTMAN_IDENTITY_FILE }),
  };

  const result = configSchema.parse(merged);
  return result as AgentConfig;
}
