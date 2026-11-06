// SPDX-License-Identifier: AGPL-3.0-only
import { type Oklch, oklchToCss } from './color.ts';

// The web's color tokens (apps/web index.css) as sRGB, per palette and mode. Olive, the default,
// lists its values; the other four derive from the web's four variables (--nh, --nc: neutral hue
// and strength; --bh, --bc: brand hue and chroma) with the same lightness values as the web's
// light-dark() block. --live, --destructive and --warning are the same in every palette.

export const PALETTES = ['olive', 'blue', 'violet', 'rose', 'graphite'] as const;
export type PaletteId = (typeof PALETTES)[number];
export const DEFAULT_PALETTE: PaletteId = 'olive';

export type Mode = 'light' | 'dark';

export const TOKENS = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'destructive',
  'warning',
  'live',
  'liveForeground',
  'border',
  'input',
  'ring',
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
] as const;
export type Token = (typeof TOKENS)[number];
export type Colors = Record<Token, string>;
type Specs = Record<Token, Oklch>;

const o = (l: number, c: number, h: number, a?: number): Oklch =>
  a === undefined ? { l, c, h } : { l, c, h, a };

/** The web's --nh, --nc, --bh, --bc of each derived palette (and violet's chart-4 hues). */
export const PALETTE_VARIABLES: Record<
  Exclude<PaletteId, 'olive'>,
  { nh: number; nc: number; bh: number; bc: number; chart4?: [number, number] }
> = {
  blue: { nh: 250, nc: 1.5, bh: 255, bc: 0.14 },
  violet: { nh: 295, nc: 1.5, bh: 295, bc: 0.16, chart4: [340, 340] },
  rose: { nh: 5, nc: 1.2, bh: 355, bc: 0.16 },
  graphite: { nh: 260, nc: 0.3, bh: 260, bc: 0.02 },
};

const OLIVE: Record<Mode, Specs> = {
  light: {
    background: o(0.966, 0.005, 106.5),
    foreground: o(0.153, 0.006, 107.1),
    card: o(1, 0, 0),
    cardForeground: o(0.153, 0.006, 107.1),
    primary: o(0.5, 0.09, 135),
    primaryForeground: o(0.988, 0.003, 106.5),
    secondary: o(0.925, 0.008, 106.5),
    secondaryForeground: o(0.228, 0.013, 107.4),
    muted: o(0.925, 0.008, 106.5),
    mutedForeground: o(0.5, 0.031, 107.3),
    accent: o(0.925, 0.008, 106.5),
    accentForeground: o(0.228, 0.013, 107.4),
    destructive: o(0.54, 0.22, 27.325),
    warning: o(0.555, 0.163, 48.998),
    live: o(0.58, 0.21, 12),
    liveForeground: o(0.988, 0.003, 106.5),
    border: o(0.9, 0.008, 106.5),
    input: o(0.9, 0.008, 106.5),
    ring: o(0.72, 0.08, 135),
    chart1: o(0.5, 0.09, 135),
    chart2: o(0.58, 0.09, 220),
    chart3: o(0.6, 0.13, 75),
    chart4: o(0.55, 0.12, 300),
    chart5: o(0.55, 0.08, 50),
  },
  dark: {
    background: o(0.153, 0.006, 107.1),
    foreground: o(0.988, 0.003, 106.5),
    card: o(0.228, 0.013, 107.4),
    cardForeground: o(0.988, 0.003, 106.5),
    primary: o(0.72, 0.09, 135),
    primaryForeground: o(0.153, 0.006, 107.1),
    secondary: o(0.286, 0.016, 107.4),
    secondaryForeground: o(0.988, 0.003, 106.5),
    muted: o(0.286, 0.016, 107.4),
    mutedForeground: o(0.737, 0.021, 106.9),
    accent: o(0.286, 0.016, 107.4),
    accentForeground: o(0.988, 0.003, 106.5),
    destructive: o(0.704, 0.191, 22.216),
    warning: o(0.828, 0.189, 84.429),
    live: o(0.7, 0.19, 8),
    liveForeground: o(0.153, 0.006, 107.1),
    border: o(1, 0, 0, 0.1),
    input: o(1, 0, 0, 0.15),
    ring: o(0.5, 0.09, 135),
    chart1: o(0.72, 0.09, 135),
    chart2: o(0.72, 0.09, 220),
    chart3: o(0.8, 0.14, 80),
    chart4: o(0.72, 0.12, 300),
    chart5: o(0.72, 0.09, 55),
  },
};

function derive(id: Exclude<PaletteId, 'olive'>, mode: Mode): Specs {
  const { nh, nc, bh, bc, chart4 } = PALETTE_VARIABLES[id];
  const light = mode === 'light';
  const olive = OLIVE[mode];
  const neutral = (l: number, c: number) => o(l, c * nc, nh);
  const foreground = light ? neutral(0.153, 0.006) : neutral(0.988, 0.003);
  const secondary = light ? neutral(0.925, 0.008) : neutral(0.286, 0.016);
  const secondaryForeground = light ? neutral(0.228, 0.013) : neutral(0.988, 0.003);
  const primary = o(light ? 0.5 : 0.72, bc, bh);
  return {
    background: light ? neutral(0.966, 0.005) : neutral(0.153, 0.006),
    foreground,
    card: light ? o(1, 0, 0) : neutral(0.228, 0.013),
    cardForeground: foreground,
    primary,
    primaryForeground: light ? neutral(0.988, 0.003) : neutral(0.153, 0.006),
    secondary,
    secondaryForeground,
    muted: secondary,
    mutedForeground: light ? neutral(0.5, 0.031) : neutral(0.737, 0.021),
    accent: secondary,
    accentForeground: secondaryForeground,
    destructive: olive.destructive,
    warning: olive.warning,
    live: olive.live,
    liveForeground: olive.liveForeground,
    border: light ? neutral(0.9, 0.008) : olive.border,
    input: light ? neutral(0.9, 0.008) : olive.input,
    ring: light ? o(0.72, bc * 0.9, bh) : o(0.5, bc, bh),
    chart1: primary,
    chart2: olive.chart2,
    chart3: olive.chart3,
    chart4: chart4 ? o(light ? 0.55 : 0.72, 0.12, chart4[light ? 0 : 1]) : olive.chart4,
    chart5: olive.chart5,
  };
}

const specsFor = (id: PaletteId, mode: Mode): Specs =>
  id === 'olive' ? OLIVE[mode] : derive(id, mode);

const cache = new Map<string, Colors>();

/** Every token of a palette in a mode, as `#rrggbb` (or `rgba()` for the dark hairlines). */
export function paletteColors(id: PaletteId, mode: Mode): Colors {
  const key = `${id}/${mode}`;
  let colors = cache.get(key);
  if (!colors) {
    const specs = specsFor(id, mode);
    colors = Object.fromEntries(TOKENS.map((t) => [t, oklchToCss(specs[t])])) as Colors;
    cache.set(key, colors);
  }
  return colors;
}

/** The swatch of a palette in pickers: its light-mode primary. */
export const paletteSwatch = (id: PaletteId): string => paletteColors(id, 'light').primary;

export const isPalette = (value: unknown): value is PaletteId =>
  PALETTES.includes(value as PaletteId);
