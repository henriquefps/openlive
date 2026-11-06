// SPDX-License-Identifier: AGPL-3.0-only

// The rules of SectionSelect (components/ui/SectionSelect.tsx), the phone's version of the web's
// SpaceSectionSwitcher, pure so they are tested without a device.

export interface Section<T extends string = string> {
  value: T;
  label: string;
  /** A count or a word next to the label (unread, pending); hidden when empty or 0. */
  badge?: number | string | undefined;
}

/** Up to this many sections a segmented control fits the width; more go in a picker. */
export const SEGMENTED_MAX = 3;

/** A segmented control for 2 or 3 sections, a full-width picker for 4 or more. */
export const sectionPresentation = (count: number): 'segmented' | 'picker' =>
  count <= SEGMENTED_MAX ? 'segmented' : 'picker';

/** The section to show: the one asked for, else the first (a stale value never shows nothing). */
export function resolveSection<T extends string>(
  sections: readonly Section<T>[],
  value: string | undefined,
): Section<T> | undefined {
  return sections.find((s) => s.value === value) ?? sections[0];
}

/** The text of a badge: counts above 99 read "99+", 0 and empty text read as no badge. */
export function badgeText(badge: number | string | undefined): string | null {
  if (badge === undefined || badge === '' || badge === 0) return null;
  if (typeof badge === 'number') return badge > 99 ? '99+' : String(badge);
  return badge;
}
