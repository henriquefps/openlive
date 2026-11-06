// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/lib/color.ts';
import { type Mode, PALETTES, paletteColors } from '../src/lib/palette.ts';
import {
  SWITCH_INSET,
  SWITCH_THUMB,
  SWITCH_TRAVEL,
  SWITCH_WIDTH,
  thumbOffset,
  toggleColors,
} from '../src/lib/toggle-colors.ts';

const MODES: Mode[] = ['light', 'dark'];

describe('toggleColors', () => {
  for (const id of PALETTES) {
    for (const mode of MODES) {
      it(`${id}/${mode}: the on thumb stands out from the primary track`, () => {
        const colors = paletteColors(id, mode);
        const on = toggleColors(colors, true);
        expect(on.trackOn).toBe(colors.primary);
        expect(contrastRatio(on.thumb, on.trackOn)).toBeGreaterThan(3);
      });

      it(`${id}/${mode}: the off thumb stands out from the off track`, () => {
        const colors = paletteColors(id, mode);
        const off = toggleColors(colors, false);
        expect(contrastRatio(off.thumb, off.trackOff)).toBeGreaterThan(2);
      });
    }
  }
});

describe('thumbOffset', () => {
  it('rests at the start when off and slides to the end when on', () => {
    expect(thumbOffset(false)).toBe(0);
    expect(thumbOffset(true)).toBe(SWITCH_TRAVEL);
    // The thumb stays inside the track, with the same gap on both sides.
    expect(SWITCH_INSET * 2 + SWITCH_THUMB + SWITCH_TRAVEL + 4).toBe(SWITCH_WIDTH);
  });
});
