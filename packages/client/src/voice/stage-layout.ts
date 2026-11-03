// SPDX-License-Identifier: AGPL-3.0-only

// The call layout of the room's stage (RoomStage.tsx), as a pure function of the tiles and the
// size of the stage, so it can be tested without a browser:
//
// - Gallery: the main tiles fill the stage. Columns and rows come from the stage's width AND
//   height and the tile count. A tile takes the shape of its cell within a range (portrait tiles
//   on a phone, close to 16:9 on a wider stage) and the video covers it, cropped and centred,
//   like Meet or FaceTime: no empty bands, no scroll. On a phone a last row that is not full
//   gets wider tiles.
// - Video first: when someone has a camera (or a stream is live), the video tiles take the big
//   area and the voice-only people sit in a compact strip below, so nobody gets a big empty box.
//   With no video at all, the voice tiles fill the stage themselves (up to a sensible size on a
//   wide stage), the avatar centred.
// - A cap: past MAX_MAIN tiles (fewer on a phone-sized stage) the rest go to the strip, which
//   scrolls; everyone stays reachable (their menu too).
// - 1:1: you and one other person, no stream: they take the stage and you float as a small
//   picture-in-picture in a corner.
// - Spotlight: a pinned (enlarged) camera takes the stage, the others go to a filmstrip on the
//   side (wide stage) or at the bottom (narrow stage).

export interface LayoutTile {
  id: string;
  /** A camera or a stream: something to watch, which gets the big area first. */
  video: boolean;
  /** This person's own tile (the picture-in-picture in a 1:1 call). */
  self?: boolean;
  /** A live stream's tile (never the picture-in-picture, always in the main area first). */
  stream?: boolean;
}

export interface StageLayoutInput {
  tiles: readonly LayoutTile[];
  /** The stage's size in CSS pixels. 0 when not measured yet. */
  width: number;
  height: number;
  /** The pinned tile (an enlarged camera), if it is on the stage. */
  pinned?: string | null;
  /** A voice channel (people are the page): larger voice-only tiles. */
  large?: boolean;
}

export type StageMode = 'gallery' | 'spotlight';

export interface StageLayout {
  mode: StageMode;
  /** The tiles of the big area, in order. */
  main: string[];
  columns: number;
  rows: number;
  /** The size of each main tile (the spotlight in spotlight mode), CSS pixels. */
  tileWidth: number;
  tileHeight: number;
  /** The width of the tiles of a last row that is not full (wider, to fill the row). */
  lastRowTileWidth: number;
  /** The compact tiles: the voice-only people beside video, the overflow, or the filmstrip. */
  strip: string[];
  /** Where the strip is: under the main area or, for a spotlight on a wide stage, beside it. */
  stripSide: 'bottom' | 'side';
  /** The room kept for the strip (its height at the bottom, its width on the side). */
  stripSize: number;
  /** Your own tile as a floating picture-in-picture (1:1 call), if any. */
  pip: string | null;
  /** The picture-in-picture's size. */
  pipWidth: number;
  pipHeight: number;
}

export const GAP = 8;
/** A camera's own shape (16:9): the strip, and how much of a cropped video a tile shows. */
export const ASPECT = 16 / 9;
/**
 * How far a tile's shape may stray from the video's. The video is cropped to fill its tile
 * (object-cover, centred), so the tiles can take the stage's shape instead of leaving empty
 * bands. On a phone-sized stage tiles may be as tall as a portrait phone camera (9:19); on a
 * wider stage they stay close to video (4:3 to 16:9) so faces are not cropped much, a little
 * wider (2:1) on a short stage such as a phone on its side.
 */
export interface AspectRange {
  min: number;
  max: number;
}
export const ASPECT_NARROW: AspectRange = { min: 9 / 19, max: 16 / 9 };
export const ASPECT_WIDE: AspectRange = { min: 4 / 3, max: 16 / 9 };
export const ASPECT_SHORT: AspectRange = { min: 4 / 3, max: 2 };
/** Below this stage height (and not narrow) the stage is short. */
export const SHORT = 480;
/** A compact tile of the strip: 160×90. */
export const STRIP_TILE_WIDTH = 160;
export const STRIP_TILE_HEIGHT = 90;
/** The bottom strip: a row of compact tiles, its gap above and room for a scroll bar. */
export const STRIP_HEIGHT = STRIP_TILE_HEIGHT + GAP + 4;
/** The side filmstrip of a spotlight on a wide stage. */
export const SIDE_STRIP_WIDTH = 200;
/** Below this stage width the stage is phone-sized: fewer main tiles, filmstrip at the bottom. */
export const NARROW = 640;
export const MAX_MAIN = 9;
/** Main tiles narrower than this move to the strip (labels and faces stay readable). */
export const MIN_TILE = STRIP_TILE_WIDTH;
export const MAX_MAIN_NARROW = 6;
/**
 * Voice-only tiles on a wide stage do not grow past this width (a huge box around a capped
 * avatar reads empty). On a phone-sized stage they fill it, like the video tiles.
 */
export const MAX_VOICE_TILE = 560;
export const MAX_VOICE_TILE_LARGE = 680;
/** The self picture-in-picture on a phone-sized stage: portrait 3:4, like a front camera. */
export const PIP_ASPECT_NARROW = 3 / 4;

export interface Grid {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** The width of the tiles of a last row that is not full (wider, to fill the row). */
  lastRowTileWidth: number;
}

/** The tile shapes allowed on a stage of this size. */
export function aspectRange(width: number, height: number): AspectRange {
  if (width < NARROW) return ASPECT_NARROW;
  return height < SHORT ? ASPECT_SHORT : ASPECT_WIDE;
}

/** The largest box inside `width` × `height` whose shape stays within `range`. */
export function fit(
  width: number,
  height: number,
  range: AspectRange,
): { width: number; height: number } {
  let w = Math.max(0, width);
  let h = Math.max(0, height);
  if (w === 0 || h === 0) return { width: 0, height: 0 };
  if (w / h > range.max) w = h * range.max;
  else if (w / h < range.min) h = w / range.min;
  return { width: w, height: h };
}

/**
 * How a tile of this size shows a 16:9 video that covers it (object-cover, centred): the width
 * the video is drawn at (faces scale with it), times a mild penalty for how much is cropped
 * away, so a sliver that blows the video up but shows a third of it does not win.
 */
export function tileScore(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  const aspect = width / height;
  const shown = Math.min(aspect, ASPECT) / Math.max(aspect, ASPECT);
  return Math.max(width, height * ASPECT) * shown ** CROP_PENALTY;
}
/** How much tileScore cares about the cropped part (0: not at all, 1: like a 16:9 fit). */
const CROP_PENALTY = 0.35;

/**
 * The grid that shows `count` tiles best inside `width` × `height`: every column count is tried,
 * each tile fills its cell within the allowed shapes, and the best tileScore wins. Grids whose
 * tiles are at least MIN_TILE wide come first. On a phone-sized stage a last row that is not full
 * gets wider tiles (still within the allowed shapes): 3 people are two on top and one below.
 */
export function bestGrid(
  count: number,
  width: number,
  height: number,
  range: AspectRange = aspectRange(width, height),
): Grid {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { columns: 0, rows: 0, tileWidth: 0, tileHeight: 0, lastRowTileWidth: 0 };
  }
  let best: Grid | null = null;
  let bestKey: [number, number] = [-1, -1];
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    // A column count that leaves a whole row empty is never better than one less.
    if (columns > 1 && Math.ceil(count / (columns - 1)) === rows) continue;
    const cellWidth = (width - (columns - 1) * GAP) / columns;
    const cellHeight = (height - (rows - 1) * GAP) / rows;
    const box = fit(cellWidth, cellHeight, range);
    const key: [number, number] = [box.width >= MIN_TILE ? 1 : 0, tileScore(box.width, box.height)];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      const last = count - (rows - 1) * columns;
      const lastRowTileWidth =
        last < columns && width < NARROW
          ? Math.max(box.width, Math.min((width - (last - 1) * GAP) / last, box.height * range.max))
          : box.width;
      best = { columns, rows, tileWidth: box.width, tileHeight: box.height, lastRowTileWidth };
      bestKey = key;
    }
  }
  return best as Grid;
}

export function stageLayout(input: StageLayoutInput): StageLayout {
  const { tiles, width, height } = input;
  const narrow = width < NARROW;
  const range = aspectRange(width, height);
  const cap = narrow ? MAX_MAIN_NARROW : MAX_MAIN;
  const empty: StageLayout = {
    mode: 'gallery',
    main: [],
    columns: 0,
    rows: 0,
    tileWidth: 0,
    tileHeight: 0,
    lastRowTileWidth: 0,
    strip: [],
    stripSide: 'bottom',
    stripSize: 0,
    pip: null,
    pipWidth: 0,
    pipHeight: 0,
  };
  if (tiles.length === 0) return empty;

  // Spotlight: the pinned camera big, everyone else in the filmstrip.
  const pinned = input.pinned ? tiles.find((t) => t.id === input.pinned) : undefined;
  if (pinned) {
    const strip = tiles.filter((t) => t !== pinned).map((t) => t.id);
    const side = !narrow && strip.length > 0;
    const stripSize = strip.length === 0 ? 0 : side ? SIDE_STRIP_WIDTH + GAP : STRIP_HEIGHT;
    const box = side
      ? fit(width - stripSize, height, aspectRange(width - stripSize, height))
      : fit(width, height - stripSize, aspectRange(width, height - stripSize));
    return {
      ...empty,
      mode: 'spotlight',
      main: [pinned.id],
      columns: 1,
      rows: 1,
      tileWidth: box.width,
      tileHeight: box.height,
      lastRowTileWidth: box.width,
      strip,
      stripSide: side ? 'side' : 'bottom',
      stripSize,
    };
  }

  // 1:1: the other person takes the stage, you float in a corner. Only when someone has video:
  // two voice-only people read better as two tiles side by side.
  const self = tiles.find((t) => t.self);
  const anyVideo = tiles.some((t) => t.video);
  if (tiles.length === 2 && self && anyVideo && !tiles.some((t) => t.stream)) {
    const other = tiles.find((t) => t !== self) as LayoutTile;
    const box = other.video
      ? fit(width, height, range)
      : voiceBox(width, height, range, narrow, input.large);
    const pip = pipSize(box, narrow);
    return {
      ...empty,
      main: [other.id],
      columns: 1,
      rows: 1,
      tileWidth: box.width,
      tileHeight: box.height,
      lastRowTileWidth: box.width,
      pip: self.id,
      pipWidth: pip.width,
      pipHeight: pip.height,
    };
  }

  // Video first: with any video on the stage, the voice-only people go to the strip.
  let main = anyVideo ? tiles.filter((t) => t.video) : [...tiles];
  let strip = anyVideo ? tiles.filter((t) => !t.video) : [];
  if (main.length > cap) {
    // Over the cap: the first ones stay (streams and you first), the rest join the strip in their
    // order. Nothing moves when someone speaks.
    const keep = [
      ...main.filter((t) => t.stream || t.self),
      ...main.filter((t) => !t.stream && !t.self),
    ]
      .slice(0, cap)
      .map((t) => t.id);
    const kept = new Set(keep);
    main = main.filter((t) => kept.has(t.id));
    const over = new Set(tiles.filter((t) => !kept.has(t.id)).map((t) => t.id));
    strip = tiles.filter((t) => over.has(t.id));
  }
  const gridOf = (count: number, stripped: boolean) => {
    const areaHeight = height - (stripped ? STRIP_HEIGHT : 0);
    return anyVideo
      ? bestGrid(count, width, areaHeight)
      : voiceGrid(count, width, areaHeight, narrow, input.large);
  };
  let grid = gridOf(main.length, strip.length > 0);
  // A short stage (a phone on its side): fewer main tiles rather than unreadable ones. The last
  // ones (never you or a stream) move to the strip until the tiles are MIN_TILE wide.
  while (main.length > 1 && width > 0 && grid.tileWidth < MIN_TILE) {
    const index = main.findLastIndex((t) => !t.self && !t.stream);
    if (index < 0) break;
    const moved = main[index] as LayoutTile;
    main = main.filter((t) => t !== moved);
    strip = tiles.filter((t) => t === moved || strip.includes(t));
    grid = gridOf(main.length, true);
  }
  const stripSize = strip.length > 0 ? STRIP_HEIGHT : 0;
  return {
    ...empty,
    main: main.map((t) => t.id),
    ...grid,
    strip: strip.map((t) => t.id),
    stripSize,
  };
}

/**
 * Your own tile over the other person's (1:1). On a phone-sized stage it is portrait (3:4, like a
 * front camera), 30 % of their tile's width, 80-120 px wide; elsewhere 16:9, a quarter of their
 * tile, 96-240 px wide. Never more than 40 % of their tile's height.
 */
function pipSize(box: { width: number; height: number }, narrow: boolean) {
  const aspect = narrow ? PIP_ASPECT_NARROW : ASPECT;
  const [min, max, share] = narrow ? [80, 120, 0.3] : [96, 240, 0.25];
  const width = Math.round(
    Math.max(min, Math.min(max, box.width * share, box.height * 0.4 * aspect)),
  );
  return { width, height: Math.round(width / aspect) };
}

/**
 * Voice-only tiles: the same grid. On a wide stage they are no larger than a sensible size (the
 * avatar is capped, a huge box around it reads empty); on a phone they fill the stage.
 */
function voiceGrid(
  count: number,
  width: number,
  height: number,
  narrow: boolean,
  large?: boolean,
): Grid {
  const grid = bestGrid(count, width, height);
  const max = large ? MAX_VOICE_TILE_LARGE : MAX_VOICE_TILE;
  if (narrow || grid.tileWidth <= max) return grid;
  const scale = max / grid.tileWidth;
  return {
    ...grid,
    tileWidth: max,
    tileHeight: grid.tileHeight * scale,
    lastRowTileWidth: Math.min(grid.lastRowTileWidth, max),
  };
}

function voiceBox(
  width: number,
  height: number,
  range: AspectRange,
  narrow: boolean,
  large?: boolean,
) {
  const box = fit(width, height, range);
  const max = large ? MAX_VOICE_TILE_LARGE : MAX_VOICE_TILE;
  if (narrow || box.width <= max) return box;
  return { width: max, height: (box.height * max) / box.width };
}

/** The width of each main tile, in order (the last row may be wider). */
export function mainTileWidths(layout: StageLayout): number[] {
  const { main, columns, tileWidth, lastRowTileWidth } = layout;
  const lastRowStart = columns > 0 ? (layout.rows - 1) * columns : 0;
  return main.map((_, index) => (index >= lastRowStart ? lastRowTileWidth : tileWidth));
}

/**
 * The camera tiles' needed widths by user id, for the layer choice (pickHighLayers): the width a
 * 16:9 video is drawn at to cover its tile (coverWidth), so a tall tile on a phone, which shows
 * the middle of a larger picture, asks for the resolution it really needs.
 */
export function tileWidths(layout: StageLayout, cameras: readonly string[]): Map<string, number> {
  const widths = new Map<string, number>();
  const main = mainTileWidths(layout);
  for (const id of cameras) {
    const index = layout.main.indexOf(id);
    if (index >= 0) widths.set(id, coverWidth(main[index] ?? 0, layout.tileHeight));
    else if (layout.pip === id) widths.set(id, coverWidth(layout.pipWidth, layout.pipHeight));
    else widths.set(id, layout.stripSide === 'side' ? SIDE_STRIP_WIDTH : STRIP_TILE_WIDTH);
  }
  return widths;
}

/** The width a 16:9 video is drawn at to cover a `width` × `height` tile (object-cover). */
export function coverWidth(width: number, height: number): number {
  return Math.round(Math.max(width, height * ASPECT));
}

/** A camera shown at least this wide asks for the high layer (360p)... */
export const HIGH_UP = 360;
/** ...and goes back to the low one (180p) only below this, so a resize does not flap. */
export const HIGH_DOWN = 300;
/** At most this many cameras on the high layer at once (as many as one pull request). */
export const MAX_HIGH = 4;

/**
 * Which cameras want the high layer, from how wide they are shown. Hysteresis: a camera already
 * on the high layer keeps it down to HIGH_DOWN. At most MAX_HIGH, the widest first, then the ones
 * already high, then in order. The network rules (poor, bad) are the camera client's.
 */
export function pickHighLayers(
  widths: ReadonlyMap<string, number>,
  previous: ReadonlySet<string>,
): Set<string> {
  const wanted = [...widths]
    .map(([id, width], index) => ({ id, width, index, was: previous.has(id) }))
    .filter((c) => c.width >= (c.was ? HIGH_DOWN : HIGH_UP));
  wanted.sort((a, b) => b.width - a.width || Number(b.was) - Number(a.was) || a.index - b.index);
  return new Set(wanted.slice(0, MAX_HIGH).map((c) => c.id));
}
