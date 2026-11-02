// SPDX-License-Identifier: AGPL-3.0-only
import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * Whether the element is at least `minWidth` px wide, following resizes (a container query in
 * script, for the places that must render different markup rather than hide some of it). Until
 * the element has a measurable width (first render, jsdom) it counts as wide.
 */
export function useIsContainerAtLeast(
  ref: RefObject<HTMLElement | null>,
  minWidth: number,
): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) => {
      if (width > 0) setWide(width >= minWidth);
    };
    apply(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, minWidth]);
  return wide;
}
