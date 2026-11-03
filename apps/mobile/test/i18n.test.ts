// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import ptBR from '../src/i18n/locales/pt-BR.json';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('locales', () => {
  it('have the same keys in English and Portuguese', () => {
    expect(keys(ptBR).sort()).toEqual(keys(en).sort());
  });
});
