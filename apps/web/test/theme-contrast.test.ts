// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG AA for the theme tokens in src/index.css: 4.5:1 for text, 3:1 for UI marks (chart fills,
// dots). The tokens are parsed from the stylesheet so a changed value is checked, not a copy.

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The token block for a theme: the `:root` rule (light) or the `.dark` rule. */
function tokens(selector: ':root' | '.dark'): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries(
    [...body.matchAll(/^\s+--([\w-]+): (oklch\([^)]+\));/gm)].map((m) => [m[1], m[2]]),
  );
}

type Rgb = [number, number, number];

/** OKLCH to linear sRGB (Björn Ottosson's matrices), clamped to the gamut. */
function toLinear(color: string): Rgb {
  const [l = 0, c = 0, h = 0] = color.match(/[\d.]+/g)?.map(Number) ?? [];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: Rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(toLinear(a)), luminance(toLinear(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// [foreground token, background token, minimum ratio]
const TEXT: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['foreground', 'card', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['secondary-foreground', 'secondary', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['sidebar-accent-foreground', 'sidebar-accent', 4.5],
  ['sidebar-foreground', 'sidebar-accent', 4.5],
  ['live-foreground', 'live', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['destructive', 'card', 4.5],
  ['destructive', 'muted', 4.5],
];
// Chart fills sit on the card and on the muted bar track; live also marks dots on both surfaces.
const MARKS: [string, string, number][] = [
  ...['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'live'].flatMap(
    (t): [string, string, number][] => [
      [t, 'card', 3],
      [t, 'muted', 3],
    ],
  ),
];

describe.each([
  ['light', tokens(':root')],
  ['dark', tokens('.dark')],
] as const)('%s theme contrast', (_name, t) => {
  it.each([...TEXT, ...MARKS])('%s on %s is at least %d:1', (fg, bg, min) => {
    expect(t[fg], fg).toBeDefined();
    expect(t[bg], bg).toBeDefined();
    expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(min);
  });

  it('keeps secondary, muted and accent visibly apart from the card and background', () => {
    for (const token of ['secondary', 'muted', 'accent']) {
      expect(contrast(t[token] as string, t.card as string), token).toBeGreaterThan(1.1);
    }
  });

  it('keeps the chart colors pairwise distinct in lightness or hue', () => {
    const hues = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'].map((k) =>
      (t[k] as string).match(/[\d.]+/g)?.map(Number),
    );
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const [a = 0, b = 0] = [hues[i]?.[2], hues[j]?.[2]];
        const dh = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
        expect(dh, `chart-${i + 1} vs chart-${j + 1}`).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('keeps live distinct from destructive', () => {
    const live = (t.live as string).match(/[\d.]+/g)?.map(Number) ?? [];
    const bad = (t.destructive as string).match(/[\d.]+/g)?.map(Number) ?? [];
    expect(Math.abs((live[2] ?? 0) - (bad[2] ?? 0))).toBeGreaterThanOrEqual(10);
  });
});
