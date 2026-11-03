// SPDX-License-Identifier: AGPL-3.0-only

// Rotation in the player. The app is portrait everywhere; while the player is open the phone's
// rotation is followed: landscape is full screen (video fills, bars hidden), portrait leaves it.
// The full-screen button is a manual choice that wins over the sensor: it forces landscape (also
// when the system's auto-rotate is off) and the way back is portrait. Pure, so the tests drive it;
// StreamView turns `lock` into expo-screen-orientation calls.

export type DeviceOrientation = 'portrait' | 'landscape' | 'unknown';

export type OrientationLockKind =
  /** Unlocked: the system's auto-rotate decides (off: stays portrait). */
  | 'follow'
  /** The button forced landscape; held until the button leaves it. */
  | 'landscape'
  /** The button left full screen: portrait is held for a moment, then the sensor is followed. */
  | 'portrait';

export interface RotationState {
  fullscreen: boolean;
  lock: OrientationLockKind;
  /** A manual change is being applied: the sensor's in-between readings are ignored. */
  pending: 'landscape' | 'portrait' | null;
}

export const INITIAL_ROTATION: RotationState = { fullscreen: false, lock: 'follow', pending: null };

/** How long a manual change holds (and may take to show up) before the sensor is followed again. */
export const SETTLE_MS = 2_000;

export type RotationAction =
  { type: 'device'; orientation: DeviceOrientation } | { type: 'toggle' } | { type: 'settle' };

export function rotationReducer(state: RotationState, action: RotationAction): RotationState {
  switch (action.type) {
    case 'toggle':
      return state.fullscreen
        ? { fullscreen: false, lock: 'portrait', pending: 'portrait' }
        : { fullscreen: true, lock: 'landscape', pending: 'landscape' };
    case 'device': {
      const { orientation } = action;
      if (orientation === 'unknown') return state;
      if (state.pending) {
        // Only the reading of the change being made counts.
        return orientation === state.pending ? { ...state, pending: null } : state;
      }
      const fullscreen = orientation === 'landscape';
      return fullscreen === state.fullscreen ? state : { ...state, fullscreen };
    }
    case 'settle':
      // The manual change is done; after leaving full screen the sensor is followed again.
      if (state.pending === null && state.lock !== 'portrait') return state;
      return { ...state, pending: null, lock: state.lock === 'portrait' ? 'follow' : state.lock };
  }
}

/** Whether the screen should arm the settle timer for this state. */
export const needsSettle = (state: RotationState): boolean =>
  state.pending !== null || state.lock === 'portrait';

/** expo-screen-orientation's orientation names, reduced to what the player needs. */
export function deviceOrientation(name: string | number | null | undefined): DeviceOrientation {
  const value = String(name ?? '').toUpperCase();
  if (value.startsWith('LANDSCAPE') || value === '3' || value === '4') return 'landscape';
  if (value.startsWith('PORTRAIT') || value === '1' || value === '2') return 'portrait';
  return 'unknown';
}

export const TOGGLE_ROTATION: RotationAction = { type: 'toggle' };
export const SETTLE_ROTATION: RotationAction = { type: 'settle' };

/** The action for an orientation change event. */
export const deviceRotation = (name: string | number | null | undefined): RotationAction => ({
  type: 'device',
  orientation: deviceOrientation(name),
});
