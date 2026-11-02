// SPDX-License-Identifier: AGPL-3.0-only
// Language choice order: saved preference > browser language > `en`. The saved
// preference is the profile's `users.locale` once signed in (useProfileLanguage), and a
// localStorage copy before that, so the first render is already in the right language.

export const SUPPORTED_LANGUAGES = ['en', 'pt-BR'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_STORAGE_KEY = 'openlive.language';

export function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

/**
 * Maps a BCP 47 tag to a supported language: exact match first (case-insensitive),
 * then the base language, so `pt-PT` and `pt` fall back to `pt-BR` and `en-GB` to `en`.
 */
export function matchLanguage(tag: string): Language | undefined {
  const lower = tag.toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split('-')[0];
  return SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase().split('-')[0] === base);
}

export function resolveLanguage(input: {
  saved?: string | null | undefined;
  browser?: readonly string[] | undefined;
}): Language {
  if (input.saved && isLanguage(input.saved)) return input.saved;
  for (const tag of input.browser ?? []) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

export function readSavedLanguage(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLanguage(language: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the choice then lasts
    // for this page load only.
  }
}

export function detectLanguage(): Language {
  return resolveLanguage({ saved: readSavedLanguage(), browser: navigator.languages });
}
