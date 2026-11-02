// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  formatBitrate,
  formatDate,
  formatGB,
  formatMB,
  formatRelativeDay,
  formatWait,
} from '../src/i18n/format.ts';

// ICU puts non-breaking spaces between number and unit; compare with plain spaces.
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('formatBitrate', () => {
  it('formats megabits per second per locale', () => {
    expect(plain(formatBitrate(8_500_000, 'en'))).toBe('8.5 Mb/s');
    expect(plain(formatBitrate(8_500_000, 'pt-BR'))).toBe('8,5 Mb/s');
  });

  it('switches to kilobits below 1 Mb/s', () => {
    expect(plain(formatBitrate(640_000, 'en'))).toBe('640 kb/s');
  });
});

describe('formatGB', () => {
  it('formats decimal gigabytes per locale', () => {
    expect(plain(formatGB(1_234_567_890, 'en'))).toBe('1.23 GB');
    expect(plain(formatGB(1_234_567_890, 'pt-BR'))).toBe('1,23 GB');
    expect(plain(formatGB(1_500_000_000_000, 'en'))).toBe('1,500 GB');
  });
});

describe('formatDate', () => {
  const date = new Date(Date.UTC(2026, 9, 27, 12));

  it('formats a date per locale', () => {
    expect(formatDate(date, 'en', { dateStyle: 'long', timeZone: 'UTC' })).toBe('October 27, 2026');
    expect(formatDate(date, 'pt-BR', { dateStyle: 'long', timeZone: 'UTC' })).toBe(
      '27 de outubro de 2026',
    );
  });

  it('defaults to the medium date style', () => {
    expect(formatDate(date, 'en')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date),
    );
  });
});

describe('formatMB', () => {
  it('formats decimal megabytes per locale', () => {
    expect(plain(formatMB(12_400_000, 'en'))).toBe('12.4 MB');
    expect(plain(formatMB(12_400_000, 'pt-BR'))).toBe('12,4 MB');
  });
});

describe('formatWait', () => {
  it('uses seconds under a minute and whole minutes, rounded up, above', () => {
    expect(plain(formatWait(1500, 'en'))).toBe('2 sec');
    expect(plain(formatWait(59_000, 'pt-BR'))).toBe('59 s');
    expect(plain(formatWait(60_001, 'en'))).toBe('2 min');
    expect(plain(formatWait(30 * 60_000, 'pt-BR'))).toBe('30 min');
  });
});

describe('formatRelativeDay', () => {
  const now = new Date(2026, 9, 27, 15, 30);
  const daysAgo = (n: number, hour = 9) => new Date(2026, 9, 27 - n, hour);

  it('says today and yesterday by calendar day, whatever the time', () => {
    expect(formatRelativeDay(daysAgo(0, 1), 'en', now)).toBe('today');
    expect(formatRelativeDay(daysAgo(1, 23), 'en', now)).toBe('yesterday');
    expect(formatRelativeDay(daysAgo(1, 23), 'pt-BR', now)).toBe('ontem');
  });

  it('counts days within the week', () => {
    expect(formatRelativeDay(daysAgo(3), 'en', now)).toBe('3 days ago');
    expect(formatRelativeDay(daysAgo(6), 'en', now)).toBe('6 days ago');
  });

  it('falls back to a short date, with the year only when it is not the current one', () => {
    expect(formatRelativeDay(daysAgo(7), 'en', now)).toBe('Oct 20');
    expect(formatRelativeDay(new Date(2025, 11, 3), 'en', now)).toBe('Dec 3, 2025');
  });
});
