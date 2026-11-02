// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

/**
 * The page layout by width: `mobile` below 768 px (one column), `tablet` from 768 to 1023 px
 * (the side column becomes a drawer) and `desktop` from 1024 px (two columns).
 */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE = '(max-width: 767px)';
const TABLET = '(max-width: 1023px)';

function subscribe(onChange: () => void): () => void {
  const queries = [MOBILE, TABLET].map((q) => window.matchMedia(q));
  for (const mql of queries) mql.addEventListener('change', onChange);
  return () => {
    for (const mql of queries) mql.removeEventListener('change', onChange);
  };
}

const current = (): Breakpoint =>
  window.matchMedia(MOBILE).matches
    ? 'mobile'
    : window.matchMedia(TABLET).matches
      ? 'tablet'
      : 'desktop';

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => 'desktop');
}
