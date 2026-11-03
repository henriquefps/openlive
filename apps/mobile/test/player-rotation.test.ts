// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CellularMonitor, type NetworkLike } from '../src/player/cellular.ts';
import {
  deviceOrientation,
  INITIAL_ROTATION,
  needsSettle,
  type RotationAction,
  type RotationState,
  rotationReducer,
} from '../src/player/rotation.ts';

const run = (actions: RotationAction[], from: RotationState = INITIAL_ROTATION): RotationState =>
  actions.reduce(rotationReducer, from);
const device = (orientation: 'portrait' | 'landscape' | 'unknown'): RotationAction => ({
  type: 'device',
  orientation,
});

describe('following the phone', () => {
  it('turning to landscape enters full screen, turning back leaves it', () => {
    const inLandscape = run([device('landscape')]);
    expect(inLandscape).toEqual({ fullscreen: true, lock: 'follow', pending: null });
    expect(run([device('portrait')], inLandscape).fullscreen).toBe(false);
  });

  it('upside-down portrait and unknown readings change nothing but portrait', () => {
    expect(run([device('unknown')], run([device('landscape')])).fullscreen).toBe(true);
    expect(run([device('portrait')]).fullscreen).toBe(false);
  });

  it('starts in portrait, unlocked so the system’s auto-rotate decides', () => {
    expect(INITIAL_ROTATION).toEqual({ fullscreen: false, lock: 'follow', pending: null });
    expect(needsSettle(INITIAL_ROTATION)).toBe(false);
  });
});

describe('the full-screen button', () => {
  it('forces landscape (auto-rotate off) and holds it', () => {
    const forced = run([{ type: 'toggle' }]);
    expect(forced).toEqual({ fullscreen: true, lock: 'landscape', pending: 'landscape' });
    expect(needsSettle(forced)).toBe(true);
    const arrived = run([device('landscape'), { type: 'settle' }], forced);
    expect(arrived).toEqual({ fullscreen: true, lock: 'landscape', pending: null });
    expect(needsSettle(arrived)).toBe(false);
  });

  it('ignores the sensor’s in-between portrait reading while the change is made', () => {
    const forced = run([{ type: 'toggle' }, device('portrait')]);
    expect(forced.fullscreen).toBe(true);
    expect(forced.pending).toBe('landscape');
  });

  it('leaves full screen into portrait, then follows the sensor again', () => {
    const left = run([{ type: 'toggle' }], run([device('landscape')]));
    expect(left).toEqual({ fullscreen: false, lock: 'portrait', pending: 'portrait' });
    // Held after the portrait reading, so a phone still tilted does not jump back at once.
    const held = rotationReducer(left, device('portrait'));
    expect(held.lock).toBe('portrait');
    expect(needsSettle(held)).toBe(true);
    const free = rotationReducer(held, { type: 'settle' });
    expect(free).toEqual({ fullscreen: false, lock: 'follow', pending: null });
    expect(rotationReducer(free, device('landscape')).fullscreen).toBe(true);
  });

  it('does not wait forever for a reading that never comes', () => {
    expect(run([{ type: 'toggle' }, { type: 'settle' }]).pending).toBeNull();
  });
});

describe('expo-screen-orientation names', () => {
  it('reduces them to portrait and landscape', () => {
    expect(deviceOrientation('LANDSCAPE_LEFT')).toBe('landscape');
    expect(deviceOrientation(4)).toBe('landscape');
    expect(deviceOrientation('PORTRAIT_UP')).toBe('portrait');
    expect(deviceOrientation(2)).toBe('portrait');
    expect(deviceOrientation('UNKNOWN')).toBe('unknown');
    expect(deviceOrientation(null)).toBe('unknown');
  });
});

describe('the cellular monitor', () => {
  function fake(initial: string) {
    let listener: ((s: { type?: string }) => void) | null = null;
    let removed = false;
    const network: NetworkLike = {
      getNetworkStateAsync: () => Promise.resolve({ type: initial }),
      addNetworkStateListener: (l) => {
        listener = l;
        return {
          remove: () => {
            removed = true;
          },
        };
      },
    };
    return {
      network,
      emit: (type: string) => listener?.({ type }),
      removed: () => removed,
    };
  }

  it('reads the current connection and follows changes', async () => {
    const f = fake('CELLULAR');
    const monitor = new CellularMonitor(f.network);
    expect(monitor.cellular).toBe(false);
    monitor.start();
    await Promise.resolve();
    expect(monitor.cellular).toBe(true);
    f.emit('WIFI');
    expect(monitor.cellular).toBe(false);
    f.emit('CELLULAR');
    expect(monitor.cellular).toBe(true);
    monitor.stop();
    expect(f.removed()).toBe(true);
  });

  it('is not cellular on wifi, ethernet or an unknown network', async () => {
    for (const type of ['WIFI', 'ETHERNET', 'UNKNOWN', 'NONE']) {
      const monitor = new CellularMonitor(fake(type).network);
      monitor.start();
      await Promise.resolve();
      expect(monitor.cellular).toBe(false);
    }
  });

  it('ignores a read that answers after stop', async () => {
    const monitor = new CellularMonitor(fake('CELLULAR').network);
    monitor.start();
    monitor.stop();
    await Promise.resolve();
    expect(monitor.cellular).toBe(false);
  });
});
