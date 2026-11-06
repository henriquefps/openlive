// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  badgeText,
  resolveSection,
  type Section,
  sectionPresentation,
} from '../src/lib/section-select.ts';

const sections = (n: number): Section[] =>
  Array.from({ length: n }, (_, i) => ({ value: `s${i}`, label: `Section ${i}` }));

describe('SectionSelect rules', () => {
  it('uses a segmented control for 2 or 3 sections and a picker for more', () => {
    expect(sectionPresentation(2)).toBe('segmented');
    expect(sectionPresentation(3)).toBe('segmented');
    expect(sectionPresentation(4)).toBe('picker');
    expect(sectionPresentation(7)).toBe('picker');
  });

  it('shows the asked section, else the first', () => {
    expect(resolveSection(sections(4), 's2')?.label).toBe('Section 2');
    expect(resolveSection(sections(4), 'gone')?.value).toBe('s0');
    expect(resolveSection(sections(4), undefined)?.value).toBe('s0');
    expect(resolveSection([], 's1')).toBeUndefined();
  });

  it('writes badges: counts cap at 99+, zero and empty hide', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(0)).toBeNull();
    expect(badgeText('')).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText('new')).toBe('new');
  });
});
