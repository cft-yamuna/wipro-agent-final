import { describe, it, expect } from 'vitest';
import { resolveDetectedScreen, resolveScreenMap } from '../lib/screenMap.js';
import type { DetectedScreen } from '../lib/screens.js';
import type { ScreenMapping } from '../lib/types.js';

const detectedScreens: DetectedScreen[] = [
  { hardwareId: '\\\\.\\DISPLAY1', name: 'DISPLAY1', index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
  { hardwareId: '\\\\.\\DISPLAY2', name: 'DISPLAY2', index: 1, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
  { hardwareId: '\\\\.\\DISPLAY3', name: 'DISPLAY3', index: 2, x: 3840, y: 0, width: 1920, height: 1080, primary: false },
];

describe('resolveDetectedScreen', () => {
  it('resolves display number aliases to hardware IDs', () => {
    const screen = resolveDetectedScreen('2', detectedScreens);
    expect(screen?.hardwareId).toBe('\\\\.\\DISPLAY2');
  });
});

describe('resolveScreenMap', () => {
  it('auto-fills a blank map for multi-screen apps', () => {
    const requested: ScreenMapping[] = [
      { hardwareId: '', url: '' },
      { hardwareId: '', url: '' },
      { hardwareId: '', url: '' },
    ];

    const resolved = resolveScreenMap({
      requestedScreenMap: requested,
      detectedScreens,
      totalScreens: 3,
    });

    expect(resolved.mode).toBe('auto');
    expect(resolved.screenMap.map((m) => m.hardwareId)).toEqual([
      '\\\\.\\DISPLAY1',
      '\\\\.\\DISPLAY2',
      '\\\\.\\DISPLAY3',
    ]);
  });

  it('keeps explicit assignments and auto-fills missing rows', () => {
    const requested: ScreenMapping[] = [
      { hardwareId: '2', url: '/display/a' },
      { hardwareId: '', url: '/display/b' },
      { hardwareId: '1', url: '/display/c' },
    ];

    const resolved = resolveScreenMap({
      requestedScreenMap: requested,
      detectedScreens,
      totalScreens: 3,
    });

    expect(resolved.mode).toBe('explicit+autofill');
    expect(resolved.screenMap.map((m) => m.hardwareId)).toEqual([
      '\\\\.\\DISPLAY2',
      '\\\\.\\DISPLAY3',
      '\\\\.\\DISPLAY1',
    ]);
    expect(resolved.screenMap.map((m) => m.url)).toEqual([
      '/display/a',
      '/display/b',
      '/display/c',
    ]);
  });

  it('preserves index count even when fewer physical screens are detected', () => {
    const requested: ScreenMapping[] = [];
    const oneScreen = [detectedScreens[0]];

    const resolved = resolveScreenMap({
      requestedScreenMap: requested,
      detectedScreens: oneScreen,
      totalScreens: 3,
    });

    expect(resolved.screenMap).toHaveLength(3);
    expect(resolved.screenMap[0].hardwareId).toBe('\\\\.\\DISPLAY1');
    expect(resolved.screenMap[1].hardwareId).toBe('');
    expect(resolved.screenMap[2].hardwareId).toBe('');
  });
});
