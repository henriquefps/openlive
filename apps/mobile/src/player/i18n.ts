// SPDX-License-Identifier: AGPL-3.0-only
import i18n from 'i18next';
import { playerTexts } from './locales.ts';

// Adds the player's text to the app's i18next instance (the keys are `player.*` and
// `mobile.player.*`; merged in, nothing else is replaced). Imported by the player's entry.

for (const [lng, texts] of Object.entries(playerTexts)) {
  i18n.addResourceBundle(lng, 'translation', texts, true, true);
}
