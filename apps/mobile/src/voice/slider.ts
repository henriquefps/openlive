// SPDX-License-Identifier: AGPL-3.0-only

/** The value (0..max, in `step`s) for a touch at `x` of a track `width` wide. */
export function sliderValue(x: number, width: number, max: number, step: number): number {
  if (width <= 0) return 0;
  const raw = Math.min(1, Math.max(0, x / width)) * max;
  return Math.min(max, Math.round(raw / step) * step);
}
