// SPDX-License-Identifier: AGPL-3.0-only
import type { PointerColor, PointerShape, PointerStyle } from '@openlive/protocol';

// Settings → Pointer (docs/PROTOCOL.md 7.9): how this person's visual clicks look on someone
// else's screen, from the protocol's closed lists. localStorage, like the notice settings
// (notices/settings.ts): storage can be missing or full, so reads fall back to the default and
// writes are dropped. One store per tab, so the settings card and the player agree at once.
//
// Only types come from @openlive/protocol (a runtime import would bundle its validators): the
// lists are copied, and test/pointer.test.ts checks them against the package.

export const POINTER_COLORS = [
  'olive',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'white',
] as const satisfies readonly PointerColor[];

export const POINTER_SHAPES = [
  'ring',
  'dot',
  'crosshair',
  'star',
] as const satisfies readonly PointerShape[];

/**
 * What each color draws with. The marker sits on video, never on the app's surfaces, so these
 * are fixed values rather than theme tokens; olive is the app's primary in its dark theme.
 */
export const POINTER_COLOR_VALUES: Record<PointerColor, string> = {
  olive: 'oklch(0.82 0.15 118)',
  red: 'oklch(0.66 0.22 25)',
  orange: 'oklch(0.75 0.18 55)',
  yellow: 'oklch(0.88 0.17 95)',
  green: 'oklch(0.76 0.18 150)',
  cyan: 'oklch(0.8 0.13 205)',
  blue: 'oklch(0.66 0.18 255)',
  purple: 'oklch(0.66 0.21 300)',
  pink: 'oklch(0.74 0.18 350)',
  white: 'oklch(0.98 0 0)',
};

export const DEFAULT_POINTER_STYLE: PointerStyle = { color: 'olive', shape: 'ring' };

const KEY = 'openlive.pointer';

export interface PointerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): PointerStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const isColor = (v: unknown): v is PointerColor =>
  (POINTER_COLORS as readonly unknown[]).includes(v);
const isShape = (v: unknown): v is PointerShape =>
  (POINTER_SHAPES as readonly unknown[]).includes(v);

export function loadPointerStyle(store: PointerStorage | null = storage()): PointerStyle {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_POINTER_STYLE;
    const value = JSON.parse(raw) as Partial<Record<keyof PointerStyle, unknown>>;
    return {
      color: isColor(value.color) ? value.color : DEFAULT_POINTER_STYLE.color,
      shape: isShape(value.shape) ? value.shape : DEFAULT_POINTER_STYLE.shape,
    };
  } catch {
    return DEFAULT_POINTER_STYLE;
  }
}

/** The tab's pointer style, read once and kept in step with the settings card. */
export class PointerStyleStore {
  private style: PointerStyle | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: () => PointerStorage | null = storage) {}

  get = (): PointerStyle => (this.style ??= loadPointerStyle(this.store()));

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<PointerStyle>): void {
    const next: PointerStyle = { ...this.get(), ...patch };
    this.style = next;
    try {
      this.store()?.setItem(KEY, JSON.stringify(next));
    } catch {
      // Not remembered this time.
    }
    for (const listener of this.listeners) listener();
  }
}

export const pointerStyle = new PointerStyleStore();
