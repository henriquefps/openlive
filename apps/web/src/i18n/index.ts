// SPDX-License-Identifier: AGPL-3.0-only
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from '@openlive/client/i18n';
import { DEFAULT_LANGUAGE, detectLanguage, saveLanguage, type Language } from './language.ts';

// The text is shared with the mobile app (@openlive/client, locales/).
export { resources };

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
