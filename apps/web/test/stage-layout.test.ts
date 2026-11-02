// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  ASPECT_NARROW,
  ASPECT_SHORT,
  ASPECT_WIDE,
  aspectRange,
  bestGrid,
  coverWidth,
  GAP,
  HIGH_DOWN,
  HIGH_UP,
  type LayoutTile,
  MAX_HIGH,
  MAX_MAIN,
  MAX_MAIN_NARROW,
  MAX_VOICE_TILE,
  MIN_TILE,
  pickHighLayers,
  PIP_ASPECT_NARROW,
  SIDE_STRIP_WIDTH,
  STRIP_HEIGHT,
  STRIP_TILE_WIDTH,
  stageLayout,
  tileWidths,
} from '../src/routes/room/stage-layout.ts';

// The stage's call layout (routes/room/stage-layout.ts): a gallery that fills the stage, video
// first with the voice-only people in a strip, a cap, the self picture-in-picture in a 1:1 call,
// the spotlight with its filmstrip, and which cameras ask for the high layer.

const video = (id: string, extra: Partial<LayoutTile> = {}): LayoutTile => ({
  id,
  video: true,
  ...extra,
});
const voice = (id: string, extra: Partial<LayoutTile> = {}): LayoutTile => ({
  id,
  video: false,
  ...extra,
});
const many = (n: number, make = video) => Array.from({ length: n }, (_, i) => make(`v${i}`));

// A portrait phone's stage (390×844 minus the header, the voice bar and padding), a phone on its
// side, and a desktop.
const PHONE = [358, 690] as const;
const LANDSCAPE = [812, 290] as const;
const DESKTOP = [1376, 760] as const;

describe('bestGrid', () => {
  it('one tile fills the stage, within the allowed shapes', () => {
    expect(bestGrid(1, ...PHONE)).toMatchObject({ columns: 1, rows: 1, tileWidth: 358 });
    expect(bestGrid(1, ...PHONE).tileHeight).toBe(690);
    // Desktop: no wider than 16:9 (height-bound: 760 × 16/9)...
    expect(bestGrid(1, ...DESKTOP).tileWidth).toBeCloseTo(1351.1, 1);
    // ...and no taller than 4:3.
    expect(bestGrid(1, 700, 1000)).toMatchObject({ tileWidth: 700, tileHeight: 525 });
    // A short stage may go to 2:1.
    expect(bestGrid(1, ...LANDSCAPE)).toMatchObject({ tileWidth: 580, tileHeight: 290 });
  });

  it('two side by side on a wide stage, stacked halves on a portrait phone', () => {
    expect(bestGrid(2, ...DESKTOP)).toMatchObject({ columns: 2, rows: 1 });
    expect(bestGrid(2, ...LANDSCAPE)).toMatchObject({ columns: 2, rows: 1 });
    const phone = bestGrid(2, ...PHONE);
    expect(phone).toMatchObject({ columns: 1, rows: 2, tileWidth: 358 });
    expect(phone.tileHeight).toBe((690 - GAP) / 2);
  });

  it('three and four are 2×2 filling a phone; a lone last tile spans the row', () => {
    const four = bestGrid(4, ...PHONE);
    expect(four).toMatchObject({ columns: 2, rows: 2, tileWidth: (358 - GAP) / 2 });
    expect(four.tileHeight).toBe((690 - GAP) / 2);
    expect(four.lastRowTileWidth).toBe(four.tileWidth);
    const three = bestGrid(3, ...PHONE);
    expect(three).toMatchObject({ columns: 2, rows: 2, lastRowTileWidth: 358 });
  });

  it('a wider stage stays close to video: 2×2 for three and four, 3×3 for nine', () => {
    expect(bestGrid(3, ...DESKTOP)).toMatchObject({ columns: 2, rows: 2 });
    expect(bestGrid(4, ...DESKTOP)).toMatchObject({ columns: 2, rows: 2 });
    expect(bestGrid(9, 1400, 800)).toMatchObject({ columns: 3, rows: 3 });
    for (let n = 1; n <= 9; n++) {
      const g = bestGrid(n, ...DESKTOP);
      expect(g.tileWidth / g.tileHeight).toBeGreaterThanOrEqual(ASPECT_WIDE.min - 0.001);
      expect(g.tileWidth / g.tileHeight).toBeLessThanOrEqual(ASPECT_WIDE.max + 0.001);
    }
  });

  it('a phone never gets slivers: five and six are 2×3', () => {
    expect(bestGrid(5, ...PHONE)).toMatchObject({ columns: 2, rows: 3 });
    expect(bestGrid(6, ...PHONE)).toMatchObject({ columns: 2, rows: 3 });
    for (let n = 1; n <= 6; n++) {
      const g = bestGrid(n, ...PHONE);
      expect(g.tileWidth).toBeGreaterThanOrEqual(MIN_TILE);
      expect(g.tileWidth / g.tileHeight).toBeGreaterThanOrEqual(ASPECT_NARROW.min - 0.001);
    }
  });

  it('aspectRange: portrait-friendly on a phone, close to video elsewhere', () => {
    expect(aspectRange(...PHONE)).toBe(ASPECT_NARROW);
    expect(aspectRange(...LANDSCAPE)).toBe(ASPECT_SHORT);
    expect(aspectRange(...DESKTOP)).toBe(ASPECT_WIDE);
  });

  it('never overflows the stage', () => {
    for (const [w, h] of [
      [390, 500],
      [358, 690],
      [844, 250],
      [1100, 700],
      [1920, 900],
    ] as const) {
      for (let n = 1; n <= 12; n++) {
        const g = bestGrid(n, w, h);
        expect(g.columns * g.rows).toBeGreaterThanOrEqual(n);
        expect(g.columns * g.tileWidth + (g.columns - 1) * GAP).toBeLessThanOrEqual(w + 0.01);
        expect(g.rows * g.tileHeight + (g.rows - 1) * GAP).toBeLessThanOrEqual(h + 0.01);
        const last = n - (g.rows - 1) * g.columns;
        expect(last * g.lastRowTileWidth + (last - 1) * GAP).toBeLessThanOrEqual(w + 0.01);
      }
    }
  });
});

describe('stageLayout: gallery', () => {
  it('nothing on the stage is an empty layout', () => {
    expect(stageLayout({ tiles: [], width: 800, height: 600 })).toMatchObject({
      main: [],
      strip: [],
      pip: null,
    });
  });

  it('one person is one big tile', () => {
    const layout = stageLayout({ tiles: [video('a')], width: 1000, height: 600 });
    expect(layout).toMatchObject({ mode: 'gallery', main: ['a'], strip: [], tileWidth: 1000 });
  });

  it('video first: the voice-only people go to a compact strip under the cameras', () => {
    const layout = stageLayout({
      tiles: [voice('me', { self: true }), video('bia'), voice('caio'), video('dani')],
      width: 1200,
      height: 700,
    });
    expect(layout.main).toEqual(['bia', 'dani']);
    expect(layout.strip).toEqual(['me', 'caio']);
    expect(layout.stripSize).toBe(STRIP_HEIGHT);
    // The two cameras share what is left above the strip, side by side.
    expect(layout).toMatchObject({ columns: 2, rows: 1 });
    expect(layout.tileHeight).toBeLessThanOrEqual(700 - STRIP_HEIGHT);
  });

  it('a live stream is video too, and comes first', () => {
    const layout = stageLayout({
      tiles: [video('s', { stream: true }), voice('me', { self: true }), voice('bia')],
      width: 1200,
      height: 700,
    });
    expect(layout.main).toEqual(['s']);
    expect(layout.strip).toEqual(['me', 'bia']);
    expect(layout.pip).toBeNull();
  });

  it('with no video at all, the voice tiles fill the stage up to a sensible size', () => {
    const layout = stageLayout({
      tiles: [voice('me', { self: true }), voice('bia'), voice('caio')],
      width: 1600,
      height: 900,
    });
    expect(layout.main).toEqual(['me', 'bia', 'caio']);
    expect(layout.strip).toEqual([]);
    expect(layout.tileWidth).toBe(MAX_VOICE_TILE);
    // A voice channel gets larger ones.
    const large = stageLayout({
      tiles: [voice('me', { self: true }), voice('bia'), voice('caio')],
      width: 1600,
      height: 900,
      large: true,
    });
    expect(large.tileWidth).toBeGreaterThan(MAX_VOICE_TILE);
  });

  it('on a phone: two stacked, three and four in a 2×2 that fills the stage', () => {
    const two = stageLayout({ tiles: many(2), width: PHONE[0], height: PHONE[1] });
    expect(two).toMatchObject({ columns: 1, rows: 2, tileWidth: 358 });
    const three = stageLayout({ tiles: many(3), width: PHONE[0], height: PHONE[1] });
    expect(three).toMatchObject({ columns: 2, rows: 2, lastRowTileWidth: 358 });
    const four = stageLayout({ tiles: many(4), width: PHONE[0], height: PHONE[1] });
    expect(four).toMatchObject({ columns: 2, rows: 2 });
    expect(2 * four.tileHeight + GAP).toBe(690);
    // Nobody has video: the voice tiles fill the stage the same way.
    const voices = stageLayout({ tiles: many(4, voice), width: PHONE[0], height: PHONE[1] });
    expect(voices).toMatchObject({ columns: 2, rows: 2, tileHeight: four.tileHeight });
  });

  it('past the cap the rest go to the strip; you stay on the stage', () => {
    const tiles = [...many(11), video('me', { self: true })];
    const wide = stageLayout({ tiles, width: 1400, height: 800 });
    expect(wide.main).toHaveLength(MAX_MAIN);
    expect(wide.main).toContain('me');
    expect(wide.strip).toEqual(['v8', 'v9', 'v10']);
    const phone = stageLayout({ tiles, width: 390, height: 600 });
    expect(phone.main).toHaveLength(MAX_MAIN_NARROW);
    expect(phone.strip).toHaveLength(12 - MAX_MAIN_NARROW);
  });

  it('a short stage (phone on its side) keeps fewer, readable tiles', () => {
    const tiles = [video('me', { self: true }), ...many(8)];
    const layout = stageLayout({ tiles, width: 802, height: 228 });
    expect(layout.tileWidth).toBeGreaterThanOrEqual(MIN_TILE);
    expect(layout.main).toContain('me');
    expect(layout.main.length + layout.strip.length).toBe(9);
    expect(layout.strip.length).toBeGreaterThan(0);
  });
});

describe('stageLayout: self picture-in-picture (1:1)', () => {
  it('you and one other with a camera: they fill the stage, you float in a corner', () => {
    const layout = stageLayout({
      tiles: [voice('me', { self: true }), video('bia')],
      width: 1000,
      height: 600,
    });
    expect(layout).toMatchObject({ main: ['bia'], pip: 'me', strip: [], tileWidth: 1000 });
    expect(layout.pipWidth).toBe(240);
    expect(layout.pipHeight).toBe(135);
    // On a short stage it stays small next to their tile.
    const short = stageLayout({
      tiles: [video('me', { self: true }), video('bia')],
      width: 802,
      height: 228,
    });
    expect(short.pipHeight).toBeLessThanOrEqual(short.tileHeight * 0.4 + 1);
    // On a phone they fill the whole stage and you are a small portrait picture.
    const phone = stageLayout({
      tiles: [video('me', { self: true }), video('bia')],
      width: PHONE[0],
      height: PHONE[1],
    });
    expect(phone).toMatchObject({ main: ['bia'], pip: 'me', tileWidth: 358, tileHeight: 690 });
    expect(phone.pipWidth).toBe(107);
    expect(phone.pipHeight).toBe(Math.round(107 / PIP_ASPECT_NARROW));
  });

  it('your camera over their voice tile', () => {
    const layout = stageLayout({
      tiles: [video('me', { self: true }), voice('bia')],
      width: 1000,
      height: 600,
    });
    expect(layout).toMatchObject({ main: ['bia'], pip: 'me' });
    // On a phone their voice tile fills the stage too (the avatar stays centred and capped).
    const phone = stageLayout({
      tiles: [video('me', { self: true }), voice('bia')],
      width: PHONE[0],
      height: PHONE[1],
    });
    expect(phone).toMatchObject({ tileWidth: 358, tileHeight: 690 });
  });

  it('no picture-in-picture without video, with a stream, or with three people', () => {
    expect(
      stageLayout({ tiles: [voice('me', { self: true }), voice('bia')], width: 1000, height: 600 })
        .pip,
    ).toBeNull();
    expect(
      stageLayout({
        tiles: [video('s', { stream: true }), video('me', { self: true })],
        width: 1000,
        height: 600,
      }).pip,
    ).toBeNull();
    const three = stageLayout({
      tiles: [video('me', { self: true }), video('bia'), video('caio')],
      width: 1000,
      height: 600,
    });
    expect(three.pip).toBeNull();
    expect(three.main).toEqual(['me', 'bia', 'caio']);
  });
});

describe('stageLayout: spotlight', () => {
  const tiles = [video('me', { self: true }), video('bia'), voice('caio')];

  it('the pinned camera big, the others in a filmstrip beside it on a wide stage', () => {
    const layout = stageLayout({ tiles, width: 1200, height: 700, pinned: 'bia' });
    expect(layout).toMatchObject({
      mode: 'spotlight',
      main: ['bia'],
      strip: ['me', 'caio'],
      stripSide: 'side',
      pip: null,
    });
    expect(layout.tileWidth).toBeLessThanOrEqual(1200 - SIDE_STRIP_WIDTH);
  });

  it('under it on a phone, filling the space above the filmstrip', () => {
    const layout = stageLayout({ tiles, width: PHONE[0], height: PHONE[1], pinned: 'bia' });
    expect(layout).toMatchObject({ stripSide: 'bottom', stripSize: STRIP_HEIGHT });
    expect(layout.tileWidth).toBe(358);
    expect(layout.tileHeight).toBe(690 - STRIP_HEIGHT);
  });

  it('a 1:1 spotlight has no picture-in-picture: you are in the filmstrip', () => {
    const layout = stageLayout({
      tiles: [video('me', { self: true }), video('bia')],
      width: 1200,
      height: 700,
      pinned: 'bia',
    });
    expect(layout).toMatchObject({ main: ['bia'], strip: ['me'], pip: null });
  });
});

describe('the high layer follows the tile size', () => {
  it('tileWidths: main tiles at the grid size, the strip and PiP small', () => {
    const layout = stageLayout({
      tiles: [video('me', { self: true }), video('bia')],
      width: 1000,
      height: 600,
    });
    // The tile is 1000×600 (5:3): the video covers it 1067 px wide.
    expect(tileWidths(layout, ['bia', 'me'])).toEqual(
      new Map([
        ['bia', 1067],
        ['me', 240],
      ]),
    );
    const crowded = stageLayout({ tiles: [...many(10)], width: 1400, height: 800 });
    expect(tileWidths(crowded, ['v9']).get('v9')).toBe(STRIP_TILE_WIDTH);
  });

  it('a tall tile asks for the width its covering video is drawn at', () => {
    expect(coverWidth(175, 341)).toBe(606);
    const four = stageLayout({ tiles: many(4), width: PHONE[0], height: PHONE[1] });
    // 175 px wide tiles on a phone still want the high layer: they show the middle of a 606 px
    // wide picture.
    const widths = tileWidths(four, ['v0', 'v3']);
    expect(widths.get('v0')).toBeGreaterThanOrEqual(HIGH_UP);
    expect([...pickHighLayers(widths, new Set())]).toEqual(['v0', 'v3']);
    // A lone last tile spanning the row (358×341) is at least as large.
    const three = stageLayout({ tiles: many(3), width: PHONE[0], height: PHONE[1] });
    expect(tileWidths(three, ['v2']).get('v2')).toBe(coverWidth(358, three.tileHeight));
  });

  it('large tiles go high, small ones stay low', () => {
    const widths = new Map([
      ['bia', HIGH_UP],
      ['caio', HIGH_UP - 1],
    ]);
    expect([...pickHighLayers(widths, new Set())]).toEqual(['bia']);
  });

  it('hysteresis: a high camera keeps the high layer down to HIGH_DOWN', () => {
    const shrinking = new Map([['bia', HIGH_DOWN + 10]]);
    expect([...pickHighLayers(shrinking, new Set(['bia']))]).toEqual(['bia']);
    expect([...pickHighLayers(shrinking, new Set())]).toEqual([]);
    expect([...pickHighLayers(new Map([['bia', HIGH_DOWN - 1]]), new Set(['bia']))]).toEqual([]);
  });

  it(`at most ${MAX_HIGH}, the ones already high first`, () => {
    const widths = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, 400]));
    expect([...pickHighLayers(widths, new Set())]).toEqual(['a', 'b', 'c', 'd']);
    expect([...pickHighLayers(widths, new Set(['e', 'f']))]).toEqual(['e', 'f', 'a', 'b']);
    // The widest win.
    widths.set('f', 800);
    expect([...pickHighLayers(widths, new Set())][0]).toBe('f');
  });
});
