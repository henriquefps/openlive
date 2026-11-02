// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

// One-time tips: a line of advice that shows the first time it applies on this device, then not
// again, and can be dismissed before that. localStorage, by tip id; storage can be missing or full,
// and then a tip shows each time rather than never.

const KEY = 'openlive.tips';

export interface TipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): TipStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function read(store: TipStorage | null): Record<string, true> {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? '{}');
    return typeof value === 'object' && value !== null ? (value as Record<string, true>) : {};
  } catch {
    return {};
  }
}

export function tipSeen(id: string, store: TipStorage | null = storage()): boolean {
  return read(store)[id] === true;
}

export function markTipSeen(id: string, store: TipStorage | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify({ ...read(store), [id]: true }));
  } catch {
    // Shows again next time.
  }
}

/**
 * A one-time tip: `show` while `applies` on the first time it does on this device (it stays
 * for as long as this component lives), until `dismiss`.
 */
export function useTip(id: string, applies: boolean): { show: boolean; dismiss: () => void } {
  const [pending, setPending] = useState(() => !tipSeen(id));
  useEffect(() => {
    if (applies && pending) markTipSeen(id);
  }, [id, applies, pending]);
  return { show: applies && pending, dismiss: () => setPending(false) };
}

/** iPhone, iPad and iPod (iPadOS says it is a Mac, but has touch). */
export function isIos(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : navigator,
): boolean {
  if (!nav) return false;
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  );
}
