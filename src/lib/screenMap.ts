import type { DetectedScreen } from './screens.js';
import type { ScreenMapping } from './types.js';

export type ScreenMapMode = 'none' | 'explicit' | 'explicit+autofill' | 'auto';

export interface ResolveScreenMapInput {
  requestedScreenMap: ScreenMapping[];
  detectedScreens: DetectedScreen[];
  totalScreens?: number;
}

export interface ResolveScreenMapResult {
  screenMap: ScreenMapping[];
  mode: ScreenMapMode;
}

export function resolveScreenMap(input: ResolveScreenMapInput): ResolveScreenMapResult {
  const requested = (input.requestedScreenMap || []).map((m) => ({
    hardwareId: String(m.hardwareId || '').trim(),
    url: String(m.url || ''),
    label: m.label,
  }));
  const detected = [...(input.detectedScreens || [])].sort((a, b) => a.index - b.index);
  const targetCount = Math.max(requested.length, normalizePositiveInt(input.totalScreens));

  if (targetCount === 0) {
    return { screenMap: [], mode: 'none' };
  }

  const explicitByIndex = new Map<number, string>();
  const reservedForExplicit = new Set<string>();
  for (let idx = 0; idx < targetCount; idx++) {
    const requestedId = requested[idx]?.hardwareId || '';
    if (!requestedId) continue;
    const resolved = resolveDetectedScreen(requestedId, detected);
    if (!resolved) continue;
    const key = toKey(resolved.hardwareId);
    if (reservedForExplicit.has(key)) continue;
    explicitByIndex.set(idx, resolved.hardwareId);
    reservedForExplicit.add(key);
  }

  const used = new Set<string>();
  const screenMap: ScreenMapping[] = [];
  let explicitEntries = 0;
  let autofilledEntries = 0;

  for (let idx = 0; idx < targetCount; idx++) {
    const requestedEntry = requested[idx];
    const requestedId = requestedEntry?.hardwareId || '';
    const requestedUrl = requestedEntry?.url || '';
    const requestedLabel = requestedEntry?.label;

    let finalHardwareId = requestedId;
    const explicitResolved = explicitByIndex.get(idx);
    if (explicitResolved) {
      explicitEntries++;
      finalHardwareId = explicitResolved;
    } else if (requestedId) {
      explicitEntries++;
      const fallbackPreferred = detected.find((s) => (
        !used.has(toKey(s.hardwareId)) && !reservedForExplicit.has(toKey(s.hardwareId))
      ));
      const fallbackAny = fallbackPreferred || detected.find((s) => !used.has(toKey(s.hardwareId)));
      if (fallbackAny) {
        finalHardwareId = fallbackAny.hardwareId;
        autofilledEntries++;
      }
    } else {
      const fallbackPreferred = detected.find((s) => (
        !used.has(toKey(s.hardwareId)) && !reservedForExplicit.has(toKey(s.hardwareId))
      ));
      const fallbackAny = fallbackPreferred || detected.find((s) => !used.has(toKey(s.hardwareId)));
      if (fallbackAny) {
        finalHardwareId = fallbackAny.hardwareId;
        autofilledEntries++;
      } else {
        finalHardwareId = '';
      }
    }

    if (finalHardwareId) {
      used.add(toKey(finalHardwareId));
    }

    const entry: ScreenMapping = {
      hardwareId: finalHardwareId,
      url: requestedUrl,
    };
    if (requestedLabel) {
      entry.label = requestedLabel;
    }
    screenMap.push(entry);
  }

  return {
    screenMap,
    mode: inferMode(explicitEntries, autofilledEntries),
  };
}

export function resolveDetectedScreen(id: string, detectedScreens: DetectedScreen[]): DetectedScreen | undefined {
  const requested = String(id || '').trim();
  if (!requested) return undefined;

  const direct = detectedScreens.find((s) => toKey(s.hardwareId) === toKey(requested));
  if (direct) return direct;

  if (/^\d+$/.test(requested)) {
    const suffix = 'DISPLAY' + requested;
    return detectedScreens.find((s) => {
      const hw = s.hardwareId.toUpperCase();
      return hw.endsWith(suffix) && (hw.length === suffix.length || hw[hw.length - suffix.length - 1] === '\\');
    });
  }

  return undefined;
}

function normalizePositiveInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n > 0 ? n : 0;
}

function inferMode(explicitEntries: number, autofilledEntries: number): ScreenMapMode {
  if (explicitEntries === 0 && autofilledEntries === 0) return 'none';
  if (explicitEntries === 0 && autofilledEntries > 0) return 'auto';
  if (autofilledEntries > 0) return 'explicit+autofill';
  return 'explicit';
}

function toKey(hardwareId: string): string {
  return hardwareId.toUpperCase();
}
