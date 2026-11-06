// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

// Theme choice (hfps-app-ui): `system` follows `prefers-color-scheme` through the CSS in
// index.css; `light` and `dark` put that class on <html>, which overrides the media query.
// The choice is saved in localStorage; storage can be unavailable, so every access is guarded.
// The palette is a second, independent axis: `data-palette="<id>"` on <html> (index.css). Olive,
// the default, has no attribute. The index.html CSP forbids inline scripts, so both axes are
// applied by initTheme() before the first render.

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'system';

export const THEME_STORAGE_KEY = 'openlive.theme';

export function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

export function readSavedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export const PALETTES = ['olive', 'blue', 'violet', 'rose', 'graphite'] as const;
export type Palette = (typeof PALETTES)[number];
export const DEFAULT_PALETTE: Palette = 'olive';

export const PALETTE_STORAGE_KEY = 'openlive.palette';

/** Preview colours for the pickers (light-mode primary, approximated in sRGB) and `theme-color`. */
export const PALETTE_SWATCHES: Record<Palette, string> = {
  olive: '#5b7a3a',
  blue: '#2f6fb5',
  violet: '#7a55c0',
  rose: '#c0467a',
  graphite: '#52575e',
};

export function isPalette(value: unknown): value is Palette {
  return PALETTES.includes(value as Palette);
}

export function readSavedPalette(): Palette {
  try {
    const saved = localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPalette(saved) ? saved : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  if (palette === DEFAULT_PALETTE) root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', palette);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', PALETTE_SWATCHES[palette]);
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

let current: Theme = DEFAULT_THEME;
let currentPalette: Palette = DEFAULT_PALETTE;
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The choice then lasts for this page load only.
  }
  for (const listener of listeners) listener();
}

export function getPalette(): Palette {
  return currentPalette;
}

export function setPalette(palette: Palette): void {
  currentPalette = palette;
  applyPalette(palette);
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // The choice then lasts for this page load only.
  }
  for (const listener of listeners) listener();
}

/** Reads the saved theme and palette and applies them; call once before the first render. */
export function initTheme(): void {
  current = readSavedTheme();
  applyTheme(current);
  currentPalette = readSavedPalette();
  applyPalette(currentPalette);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

export function usePalette(): Palette {
  return useSyncExternalStore(subscribe, getPalette, getPalette);
}
