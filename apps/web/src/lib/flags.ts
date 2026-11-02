// SPDX-License-Identifier: AGPL-3.0-only
// Feature flags for unfinished or development-only UI: `?flags=a,b` on any URL turns them on for
// this browser (kept in localStorage), `?flags=` turns them all off.
//
//   multiview   the multi-view placeholder in the watch view (a later phase)
//   fake        fake media (canvas clock + tone) instead of the SFU; development builds only
//   prepull     pull a stream's low layer while the pointer rests on its card (rtc/prepull.ts; on
//               by default)
//   noprepull   never pre-pull

export type Flag = 'multiview' | 'fake' | 'prepull' | 'noprepull';

const KEY = 'openlive.flags';

function read(): Set<string> {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('flags');
    if (fromUrl !== null) localStorage.setItem(KEY, fromUrl);
    const value = fromUrl ?? localStorage.getItem(KEY) ?? '';
    return new Set(
      value
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function flag(name: Flag): boolean {
  if (typeof window === 'undefined') return false;
  return read().has(name);
}

/** Fake media: never in production builds, whatever the flag says. */
export function fakeMediaEnabled(): boolean {
  return import.meta.env.MODE !== 'production' && flag('fake');
}

/**
 * Pull on hover (rtc/prepull.ts): on by default since it took the first frame from a
 * median of ~950 ms to ~365 ms for ~3–6 MB per hover without a click. `noprepull` turns it off
 * for this browser (`prepull` forces it on).
 */
export const PREPULL_DEFAULT = true;

export function prepullEnabled(): boolean {
  if (flag('noprepull')) return false;
  return PREPULL_DEFAULT || flag('prepull');
}
