// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorCode } from '@openlive/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n/index.ts';
import { ERROR_CODES, translateError } from '../src/i18n/errors.ts';

// ICU puts non-breaking spaces between number and unit; compare with plain spaces.
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('translateError', () => {
  it('interpolates the parameters of a code', async () => {
    await i18n.changeLanguage('en');
    expect(translateError({ code: ErrorCode.ViewerLimitReached, limit: 6, used: 6 })).toBe(
      'Stream full (6/6).',
    );
    await i18n.changeLanguage('pt-BR');
    expect(translateError({ code: 'viewer_limit_reached', limit: 6, used: 6 })).toBe(
      'Transmissão lotada (6/6).',
    );
  });

  it('derives seconds from retryAfterMs and translates the preset', async () => {
    await i18n.changeLanguage('en');
    expect(plain(translateError({ code: 'rate_limited', retryAfterMs: 1500 }))).toBe(
      'Too many requests. Try again in 2 sec.',
    );
    // The hourly creation limits (review L4) can mean a wait of many minutes.
    expect(plain(translateError({ code: 'rate_limited', retryAfterMs: 29 * 60_000 + 1 }))).toBe(
      'Too many requests. Try again in 30 min.',
    );
    expect(translateError({ code: 'preset_not_allowed', preset: 'native' })).toBe(
      'The Native quality is not allowed in this room.',
    );
  });

  it('falls back to a generic message for codes this build does not know', () => {
    expect(translateError({ code: 'not_a_code' })).toBe('Something went wrong. Please try again.');
  });

  it('has a translation for every protocol error code', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    for (const language of ['en', 'pt-BR']) {
      for (const code of ERROR_CODES) {
        expect(i18n.exists(`errors.${code}`, { lng: language, fallbackLng: [] })).toBe(true);
      }
    }
  });
});
