import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve, dirname } from 'path';
import { mkdirSync } from 'fs';
import type { Identity } from './types.js';

export function readIdentity(filePath: string): Identity | null {
  const fullPath = resolve(process.cwd(), filePath);

  if (!existsSync(fullPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(fullPath, 'utf-8'));
    if (raw.deviceId && raw.apiKey) {
      return { deviceId: raw.deviceId, apiKey: raw.apiKey };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeIdentity(filePath: string, identity: Identity): void {
  const fullPath = resolve(process.cwd(), filePath);
  const dir = dirname(fullPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(fullPath, JSON.stringify(identity, null, 2), { mode: 0o600 });

  // Ensure permissions are correct even if file already existed
  try {
    chmodSync(fullPath, 0o600);
  } catch {
    // Ignore permission errors on Windows
  }
}
