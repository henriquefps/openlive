// SPDX-License-Identifier: AGPL-3.0-only
// Number formats for the admin screens (Intl, decimal units as Cloudflare bills).

export const formatGigabytes = (gb: number, locale: string, digits = 1): string =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'gigabyte',
    maximumFractionDigits: digits,
  }).format(gb);

export const formatMbps = (mbps: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabit-per-second',
    maximumFractionDigits: 1,
  }).format(mbps);

export const formatHours = (hours: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(hours);

export const formatUsd = (usd: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(usd);
