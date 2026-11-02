// SPDX-License-Identifier: AGPL-3.0-only
// Locale-aware formatting with Intl. Units are decimal, as Cloudflare bills them.

export function formatBitrate(bitsPerSecond: number, locale: string): string {
  const megabits = bitsPerSecond / 1_000_000;
  if (Math.abs(megabits) >= 1) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'megabit-per-second',
      maximumFractionDigits: 1,
    }).format(megabits);
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilobit-per-second',
    maximumFractionDigits: 0,
  }).format(bitsPerSecond / 1_000);
}

export function formatGB(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'gigabyte',
    maximumFractionDigits: 2,
  }).format(bytes / 1_000_000_000);
}

export function formatDate(
  date: Date | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** A countdown: "2:05:09" from an hour up, "4:07" below (minutes and seconds). */
export function formatRemaining(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const one = new Intl.NumberFormat(locale, { useGrouping: false });
  return hours > 0
    ? `${one.format(hours)}:${two.format(minutes)}:${two.format(seconds)}`
    : `${one.format(minutes)}:${two.format(seconds)}`;
}

/** How long to wait before trying again: seconds under a minute, else whole minutes rounded up. */
export function formatWait(ms: number, locale: string): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const [value, unit] = seconds < 60 ? [seconds, 'second'] : [Math.ceil(seconds / 60), 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
}

/** A file size in megabytes (decimal, like the rest), e.g. "12.4 MB". */
export function formatMB(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);
}

const DAY_MS = 86_400_000;

/**
 * A date without time for compact lists: "today", "yesterday", "3 days ago" within the last week,
 * then "Oct 24" (with the year when it is not the current one). Calendar days, in local time.
 */
export function formatRelativeDay(
  value: Date | number,
  locale: string,
  now: Date | number = Date.now(),
): string {
  const date = new Date(value);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / DAY_MS);
  if (Math.abs(days) <= 6) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      days === 0 ? 0 : -days,
      'day',
    );
  }
  return formatDate(date, locale, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
