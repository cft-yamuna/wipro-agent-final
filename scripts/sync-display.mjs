import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const displayDistDir = resolve(rootDir, '..', 'display', 'dist');
const agentPublicDir = resolve(rootDir, 'public');

if (!existsSync(displayDistDir)) {
  console.error(`Display build not found: ${displayDistDir}`);
  process.exit(1);
}

mkdirSync(agentPublicDir, { recursive: true });

cpSync(displayDistDir, agentPublicDir, {
  recursive: true,
  force: true,
});

console.log('Display synced to agent/public/');
