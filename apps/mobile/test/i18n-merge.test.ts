// SPDX-License-Identifier: AGPL-3.0-only
import { resources as shared } from '@openlive/client/i18n';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import ptBR from '../src/i18n/locales/pt-BR.json';
import { mergeTexts, type Texts } from '../src/i18n/merge.ts';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('mergeTexts', () => {
  it('lays the app keys over the shared ones, down the tree', () => {
    expect(
      mergeTexts({ a: { x: '1', y: '2' }, b: 'B' }, { a: { y: 'Y', z: 'Z' }, c: 'C' }),
    ).toEqual({
      a: { x: '1', y: 'Y', z: 'Z' },
      b: 'B',
      c: 'C',
    });
  });
});

describe('the merged texts', () => {
  const merged = {
    en: mergeTexts(shared.en.translation, en),
    ptBR: mergeTexts(shared['pt-BR'].translation, ptBR as Texts),
  };

  it('have the same keys in both languages', () => {
    expect(keys(merged.ptBR).sort()).toEqual(keys(merged.en).sort());
  });

  it('keep the shared chat and error texts', () => {
    expect(keys(merged.en)).toContain('chat.retention.quick');
    expect(keys(merged.en)).toContain('errors.rate_limited');
    expect(keys(merged.en)).toContain('room.kickReason.banned');
  });
});
