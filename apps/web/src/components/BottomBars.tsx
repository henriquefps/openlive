// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { VoiceConnected } from '../voice/VoiceConnected.tsx';

// Bars fixed to the bottom of the screen on phones: the app's "Voice connected" bar. A page that
// lays itself out to the screen's height (the room) holds its own, so the spacer is inside it;
// else the shell's.

/** How many pages show their own bottom bars now. */
const pageBars = (() => {
  let count = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => count,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hold: () => {
      count += 1;
      emit();
      return () => {
        count -= 1;
        emit();
      };
    },
  };
})();

/**
 * Bars fixed to the bottom of the screen (the voice dock, and a page's own), with a spacer of
 * their height in the page so they never cover its end. `shell` is the app's own (only the voice
 * dock, while no page has bars).
 */
export function BottomBars({ children, shell = false }: { children?: ReactNode; shell?: boolean }) {
  const bars = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => (shell ? undefined : pageBars.hold()), [shell]);
  useLayoutEffect(() => {
    const el = bars.current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div aria-hidden style={{ height }} className="shrink-0" data-testid="bottom-spacer" />
      <div
        ref={bars}
        className="fixed inset-x-0 bottom-0 z-40 bg-card/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_12px_-6px_rgb(0_0_0/0.15)] empty:hidden supports-backdrop-filter:backdrop-blur-sm"
        data-testid={shell ? 'shell-bottom-bars' : 'bottom-bars'}
      >
        <VoiceConnected variant="bar" />
        {children}
      </div>
    </>
  );
}

/** The shell's bottom bar on phones: the voice dock, while the page has no bars of its own. */
export function ShellBottomBars({ show }: { show: boolean }) {
  const pages = useSyncExternalStore(pageBars.subscribe, pageBars.get);
  return show && pages === 0 ? <BottomBars shell /> : null;
}
