// SPDX-License-Identifier: AGPL-3.0-only
import { DEFAULT_PALETTE, isPalette, type PaletteId } from './palette.ts';

// The personal settings of this phone, kept under the same keys as the web's localStorage
// (apps/web theme.ts, language.ts): `openlive.theme`, `openlive.palette` and `openlive.language`. Pure, so the rules
// are tested without a device. The voice prefs (push-to-talk) are @openlive/client's own.

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEMES)[number];

export { DEFAULT_PALETTE, isPalette, PALETTES, type PaletteId } from './palette.ts';

export const LANGUAGES = ['system', 'en', 'pt-BR'] as const;
export type LanguageChoice = (typeof LANGUAGES)[number];

export const THEME_KEY = 'openlive.theme';
export const PALETTE_KEY = 'openlive.palette';
export const LANGUAGE_KEY = 'openlive.language';

export interface AppSettings {
  theme: ThemeChoice;
  palette: PaletteId;
  language: LanguageChoice;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  palette: DEFAULT_PALETTE,
  language: 'system',
};

export interface SettingsSource {
  getItem(key: string): string | null;
}

export const isTheme = (value: unknown): value is ThemeChoice =>
  THEMES.includes(value as ThemeChoice);

export const isLanguage = (value: unknown): value is LanguageChoice =>
  LANGUAGES.includes(value as LanguageChoice);

/** What was saved; anything unknown reads as "follow the system". */
export function loadSettings(source: SettingsSource): AppSettings {
  const theme = source.getItem(THEME_KEY);
  const palette = source.getItem(PALETTE_KEY);
  const language = source.getItem(LANGUAGE_KEY);
  return {
    theme: isTheme(theme) ? theme : DEFAULT_SETTINGS.theme,
    palette: isPalette(palette) ? palette : DEFAULT_SETTINGS.palette,
    language: isLanguage(language) ? language : DEFAULT_SETTINGS.language,
  };
}

/** pt-BR for any Portuguese system language, English otherwise. */
export function systemLanguage(tags: readonly string[]): 'en' | 'pt-BR' {
  return tags[0]?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

/** The language to show: the choice, or the system's when it follows the system. */
export function resolveLanguage(
  choice: LanguageChoice,
  systemTags: readonly string[],
): 'en' | 'pt-BR' {
  return choice === 'system' ? systemLanguage(systemTags) : choice;
}

/** The color scheme to force (Appearance.setColorScheme); `auto` follows the system. */
export const forcedScheme = (theme: ThemeChoice): 'light' | 'dark' | 'auto' =>
  theme === 'system' ? 'auto' : theme;
