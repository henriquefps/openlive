// SPDX-License-Identifier: AGPL-3.0-only
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor poll until the element or assertion appears, so a larger budget costs nothing when
// the UI is ready. The 1 s default expired on a loaded CI runner while lazy routes and queries were
// still settling (empty breadcrumb trail, missing headings), which made tests flaky.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no matchMedia; the sidebar (useIsMobile) needs one. Always "not mobile".
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
}

// jsdom has no ResizeObserver; Radix (Switch, Select) measures elements with it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
