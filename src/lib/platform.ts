import { platform } from 'os';

export type Platform = 'linux' | 'windows' | 'darwin';

export function getPlatform(): Platform {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}
