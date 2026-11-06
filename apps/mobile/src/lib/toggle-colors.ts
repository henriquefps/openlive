// SPDX-License-Identifier: AGPL-3.0-only
import type { Colors } from './palette.ts';

export interface ToggleColors {
  trackOn: string;
  trackOff: string;
  thumb: string;
}

/**
 * The colors of a switch, from the theme only (the system accent would show through as teal on
 * Android): the primary track with the on-primary thumb when on, the muted track with a muted
 * foreground thumb when off.
 */
export function toggleColors(colors: Colors, value: boolean): ToggleColors {
  return {
    trackOn: colors.primary,
    trackOff: colors.muted,
    thumb: value ? colors.primaryForeground : colors.mutedForeground,
  };
}

export const SWITCH_WIDTH = 52;
export const SWITCH_HEIGHT = 32;
const SWITCH_PADDING = 4;
const BORDER = 2;

export const SWITCH_THUMB = SWITCH_HEIGHT - 2 * SWITCH_PADDING;

/** How far the thumb slides from the off position to the on one. */
export const SWITCH_TRAVEL = SWITCH_WIDTH - SWITCH_HEIGHT;

/** The thumb's horizontal offset inside the track (the border is already inside the box). */
export const thumbOffset = (value: boolean): number => (value ? SWITCH_TRAVEL : 0);

export const SWITCH_INSET = SWITCH_PADDING - BORDER;
