// SPDX-License-Identifier: AGPL-3.0-only
// Room and space addresses (/s/friends/r/game-night). Same rule as the API's `slug` and the web's
// lib/slug.ts: lowercase letters, digits and inner hyphens, at most 48 characters.

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** A slug suggested from a name: accents dropped, everything else becomes hyphens. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
}
