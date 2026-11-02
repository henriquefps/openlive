// SPDX-License-Identifier: AGPL-3.0-only
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en/translation.json';
import ptBR from '../locales/pt-BR/translation.json';
import { DEFAULT_LANGUAGE, detectLanguage, saveLanguage, type Language } from './language.ts';

export const resources = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
} as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: (typeof resources)['en'];
  }
}

// Resources are bundled, so init is synchronous and the first render is already translated.
void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: Object.keys(resources),
  interpolation: { escapeValue: false },
  returnNull: false,
});

function syncDocumentLanguage(language: string): void {
  document.documentElement.lang = language;
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export async function changeLanguage(language: Language): Promise<void> {
  saveLanguage(language);
  await i18n.changeLanguage(language);
}

export default i18n;
