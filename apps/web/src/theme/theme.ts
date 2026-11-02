// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

// Theme choice (hfps-app-ui): `system` follows `prefers-color-scheme` through the CSS in
// index.css; `light` and `dark` put that class on <html>, which overrides the media query.
// The choice is saved in localStorage; storage can be unavailable, so every access is guarded.

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

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

let current: Theme = DEFAULT_THEME;
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

/** Reads the saved choice and applies it; call once before the first render. */
export function initTheme(): void {
  current = readSavedTheme();
  applyTheme(current);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
