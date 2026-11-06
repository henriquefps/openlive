// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { contrastRatio, oklchToCss, parseHex, withAlpha } from '../src/lib/color.ts';
import { type Mode, PALETTES, paletteColors, TOKENS } from '../src/lib/palette.ts';
import { DEFAULT_SETTINGS, loadSettings, PALETTE_KEY, THEME_KEY } from '../src/lib/settings.ts';

const MODES: Mode[] = ['light', 'dark'];
const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });

/** Channels of a `#rrggbb`, to compare with a tolerance. */
const near = (hex: string, expected: [number, number, number], tolerance = 2) => {
  const got = parseHex(hex);
  for (let i = 0; i < 3; i++)
    expect(Math.abs((got[i] ?? 0) - (expected[i] ?? 0))).toBeLessThanOrEqual(tolerance);
};

describe('oklch to sRGB', () => {
  it('maps white, black and neutral grays', () => {
    expect(oklchToCss({ l: 1, c: 0, h: 0 })).toBe('#ffffff');
    expect(oklchToCss({ l: 0, c: 0, h: 0 })).toBe('#000000');
    // oklch(0.5 0 0) is the well known rgb(99, 99, 99).
    near(oklchToCss({ l: 0.5, c: 0, h: 0 }), [99, 99, 99], 1);
  });

  it("matches the web's olive primary, oklch(0.5 0.09 135)", () => {
    // Olive green, close to the #4c6f38 the app used before.
    near(oklchToCss({ l: 0.5, c: 0.09, h: 135 }), [76, 111, 56], 6);
  });

  it('keeps the hue of a color outside the gamut instead of clipping channels', () => {
    const css = oklchToCss({ l: 0.54, c: 0.22, h: 27.325 });
    const [r, g, b] = parseHex(css);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('writes the dark hairline as a translucent white', () => {
    expect(oklchToCss({ l: 1, c: 0, h: 0, a: 0.1 })).toBe('rgba(255, 255, 255, 0.1)');
    expect(withAlpha('#ff0000', 0.2)).toBe('rgba(255, 0, 0, 0.2)');
  });

  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('palettes', () => {
  it.each(PALETTES.flatMap((p) => MODES.map((m) => [p, m] as const)))(
    '%s %s defines every token as a color',
    (palette, mode) => {
      const colors = paletteColors(palette, mode);
      expect(Object.keys(colors).sort()).toEqual([...TOKENS].sort());
      for (const token of TOKENS) {
        expect(colors[token], token).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
      }
    },
  );

  it('keeps live, destructive and warning the same in every palette', () => {
    for (const mode of MODES) {
      const olive = paletteColors('olive', mode);
      for (const palette of PALETTES) {
        const colors = paletteColors(palette, mode);
        for (const token of ['live', 'liveForeground', 'destructive', 'warning'] as const) {
          expect(colors[token], `${palette} ${mode} ${token}`).toBe(olive[token]);
        }
      }
    }
  });

  it('makes the palettes different from each other', () => {
    const primaries = PALETTES.map((p) => paletteColors(p, 'light').primary);
    expect(new Set(primaries).size).toBe(PALETTES.length);
  });

  it('lifts the card above the background in dark', () => {
    for (const palette of PALETTES) {
      const c = paletteColors(palette, 'dark');
      expect(contrastRatio(c.card, c.background), palette).toBeGreaterThan(1.05);
    }
  });
});

// The idea of apps/web/test/theme-contrast.test.ts: WCAG AA, 4.5:1 for text, 3:1 for marks.
const TEXT = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['mutedForeground', 'background'],
  ['mutedForeground', 'card'],
  ['mutedForeground', 'muted'],
  ['secondaryForeground', 'secondary'],
  ['accentForeground', 'accent'],
  ['primaryForeground', 'primary'],
  ['liveForeground', 'live'],
  ['destructive', 'card'],
  ['destructive', 'muted'],
] as const;
const MARKS = ['chart1', 'chart2', 'chart3', 'chart4', 'chart5', 'live'] as const;

describe.each(PALETTES.flatMap((p) => MODES.map((m) => [p, m] as const)))(
  '%s %s contrast',
  (palette, mode) => {
    const colors = paletteColors(palette, mode);
    it.each(TEXT)('%s on %s is at least 4.5:1', (fg, bg) => {
      expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
    });
    it.each(MARKS)('%s on the card is at least 3:1', (mark) => {
      expect(contrastRatio(colors[mark], colors.card)).toBeGreaterThanOrEqual(3);
    });
  },
);

describe('saved theme and palette', () => {
  it('defaults to following the system, in olive', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ theme: 'system', palette: 'olive' });
    expect(loadSettings(store({}))).toEqual(DEFAULT_SETTINGS);
  });

  it('reads the saved mode and palette', () => {
    expect(loadSettings(store({ [THEME_KEY]: 'dark', [PALETTE_KEY]: 'rose' }))).toMatchObject({
      theme: 'dark',
      palette: 'rose',
    });
  });

  it('falls back on an invalid value without touching the other', () => {
    expect(loadSettings(store({ [THEME_KEY]: 'light', [PALETTE_KEY]: 'neon' }))).toMatchObject({
      theme: 'light',
      palette: 'olive',
    });
    expect(loadSettings(store({ [THEME_KEY]: 'neon', [PALETTE_KEY]: 'blue' }))).toMatchObject({
      theme: 'system',
      palette: 'blue',
    });
  });

  it("uses the web's storage keys", () => {
    expect([THEME_KEY, PALETTE_KEY]).toEqual(['openlive.theme', 'openlive.palette']);
  });
});
