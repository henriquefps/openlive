// SPDX-License-Identifier: AGPL-3.0-only
import { getLocales } from 'expo-localization';
import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import i18n from './i18n/index.ts';
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  forcedScheme,
  LANGUAGE_KEY,
  loadSettings,
  PALETTE_KEY,
  resolveLanguage,
  THEME_KEY,
} from './lib/settings.ts';
import { prefsReady, voicePrefsStore } from './voice/store.ts';

// The theme and language choices of this phone, in the same store as the voice prefs (store.ts:
// AsyncStorage behind an in-memory map). Applied at start-up and on every change: the theme forces
// the color scheme (so every `useColorScheme` and the system's own dialogs follow), the language
// switches i18next.

let current: AppSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

function apply(settings: AppSettings): void {
  Appearance.setColorScheme(forcedScheme(settings.theme));
  const language = resolveLanguage(
    settings.language,
    getLocales().map((l) => l.languageTag),
  );
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

function publish(next: AppSettings): void {
  current = next;
  apply(next);
  for (const listener of listeners) listener();
}

/** Loads the saved choices once and applies them; resolves when the app can draw. */
export const settingsReady: Promise<void> = prefsReady.then(() => {
  publish(loadSettings(voicePrefsStore));
});

export function setTheme(theme: AppSettings['theme']): void {
  voicePrefsStore.setItem(THEME_KEY, theme);
  publish({ ...current, theme });
}

export function setPalette(palette: AppSettings['palette']): void {
  voicePrefsStore.setItem(PALETTE_KEY, palette);
  publish({ ...current, palette });
}

export function setLanguage(language: AppSettings['language']): void {
  voicePrefsStore.setItem(LANGUAGE_KEY, language);
  publish({ ...current, language });
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
