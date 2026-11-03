// SPDX-License-Identifier: AGPL-3.0-only
import en from '../locales/en/translation.json';
import ptBR from '../locales/pt-BR/translation.json';

// The interface text of every client, as i18next resources (one `translation` namespace per
// language). The web loads them in apps/web/src/i18n; the app loads the same files. `en` is the
// default and the fallback; `pnpm i18n:check` keeps the languages' keys equal.

export const resources = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
} as const;
