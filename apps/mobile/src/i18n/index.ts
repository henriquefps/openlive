// SPDX-License-Identifier: AGPL-3.0-only
import { resources as shared } from '@openlive/client/i18n';
import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';
import { mergeTexts } from './merge.ts';

// The shared interface text (packages/client/locales: errors, chat, presets) with the app's own
// keys on top: where both have a key, the app's wins.
export const resources = {
  en: { translation: mergeTexts(shared.en.translation, en) },
  'pt-BR': { translation: mergeTexts(shared['pt-BR'].translation, ptBR) },
} as const;

/** pt-BR for any Portuguese system language, English otherwise. */
export function pickLanguage(tags: readonly string[]): 'en' | 'pt-BR' {
  return tags[0]?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(getLocales().map((l) => l.languageTag)),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
