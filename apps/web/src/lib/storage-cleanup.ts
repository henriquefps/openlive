// SPDX-License-Identifier: AGPL-3.0-only
// Keys earlier builds wrote to localStorage and nothing reads any more. Removed once per page
// load; storage can be unavailable, so every access is guarded.

/** The per-room "lowest latency" switch, removed 2026-10-27. */
const RETIRED_PREFIXES = ['openlive.lowestLatency.'];

export function removeRetiredKeys(storage?: Storage): void {
  try {
    const store = storage ?? localStorage;
    const retired: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && RETIRED_PREFIXES.some((p) => key.startsWith(p))) retired.push(key);
    }
    for (const key of retired) store.removeItem(key);
  } catch {
    // Tried again on the next load.
  }
}
