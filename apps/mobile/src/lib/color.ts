// SPDX-License-Identifier: AGPL-3.0-only

// Color maths for the theme, pure so it is tested without a device. React Native has no OKLCH, so
// the web's tokens are converted to sRGB here (Björn Ottosson's OKLab matrices).

export interface Oklch {
  /** Lightness, 0 to 1. */
  l: number;
  /** Chroma, about 0 to 0.4. */
  c: number;
  /** Hue in degrees. */
  h: number;
  /** Opacity, 0 to 1 (the web's `oklch(1 0 0 / 10%)`). */
  a?: number;
}

type Rgb = readonly [number, number, number];

/** OKLCH to linear sRGB, not clamped. */
function toLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const EPS = 1e-6;
const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -EPS && v <= 1 + EPS);

/**
 * Linear sRGB of an OKLCH color. A color outside the sRGB gamut keeps its lightness and hue and
 * loses chroma until it fits (what browsers do), instead of clipping each channel.
 */
export function oklchToLinear(color: Oklch): Rgb {
  const first = toLinear(color);
  if (inGamut(first)) return first;
  let low = 0;
  let high = color.c;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut(toLinear({ ...color, c: mid }))) low = mid;
    else high = mid;
  }
  return toLinear({ ...color, c: low });
}

const encode = (v: number): number => {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/** `#rrggbb`, or `rgba(r, g, b, a)` when the color has an opacity below 1. */
export function oklchToCss(color: Oklch): string {
  const [r, g, b] = oklchToLinear(color).map(encode) as [number, number, number];
  if (color.a === undefined || color.a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const byte = (v: number) => Math.round(v * 255);
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${color.a})`;
}

/** `#rrggbb` with an opacity, for the web's `bg-destructive/10`. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb color: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a `#rrggbb` color. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => decode(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
