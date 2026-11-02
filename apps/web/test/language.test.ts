// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  LANGUAGE_STORAGE_KEY,
  matchLanguage,
  resolveLanguage,
  saveLanguage,
} from '../src/i18n/language.ts';

describe('resolveLanguage', () => {
  it('prefers the saved preference over the browser language', () => {
    expect(resolveLanguage({ saved: 'pt-BR', browser: ['en-US'] })).toBe('pt-BR');
    expect(resolveLanguage({ saved: 'en', browser: ['pt-BR'] })).toBe('en');
  });

  it('ignores an unsupported saved value and uses the browser language', () => {
    expect(resolveLanguage({ saved: 'fr', browser: ['pt-BR'] })).toBe('pt-BR');
  });

  it('uses the first supported browser language', () => {
    expect(resolveLanguage({ saved: null, browser: ['de-DE', 'pt-PT', 'en'] })).toBe('pt-BR');
  });

  it('falls back to en', () => {
    expect(resolveLanguage({ saved: null, browser: ['de-DE', 'ja'] })).toBe('en');
    expect(resolveLanguage({})).toBe('en');
  });
});

describe('matchLanguage', () => {
  it('matches exactly, case-insensitively, then by base language', () => {
    expect(matchLanguage('pt-br')).toBe('pt-BR');
    expect(matchLanguage('pt')).toBe('pt-BR');
    expect(matchLanguage('en-GB')).toBe('en');
    expect(matchLanguage('es')).toBeUndefined();
  });
});

describe('detectLanguage', () => {
  it('reads the saved preference from localStorage', () => {
    saveLanguage('pt-BR');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('pt-BR');
    expect(detectLanguage()).toBe('pt-BR');
  });
});
