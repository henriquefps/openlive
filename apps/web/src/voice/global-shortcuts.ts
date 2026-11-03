// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, PayloadOf } from '@openlive/protocol';
import type { VoiceClient } from './client.ts';

// Global voice shortcuts through the helper (docs/PROTOCOL.md 8.5): the helper binds push-to-talk,
// mute and deafen as system-wide shortcuts, so they work while a game has the focus, and tells
// every web tab of the user. The tab that is in voice applies them; with several, the one that
// joined voice last (a claim in localStorage that the tab keeps fresh).

/** The first protocol minor whose helper can send helper.voiceShortcut. */
export const VOICE_SHORTCUTS_MINOR = 21;

/** Whether this helper provides global voice shortcuts (1.21 or later). */
export const helperHasVoiceShortcuts = (h: Pick<HelperInfo, 'protocol'>): boolean =>
  h.protocol.major > 1 || h.protocol.minor >= VOICE_SHORTCUTS_MINOR;

/** The user's online helpers that provide global voice shortcuts. */
export function voiceShortcutHelpers(helpers: Record<string, HelperInfo>): HelperInfo[] {
  return Object.values(helpers)
    .filter(helperHasVoiceShortcuts)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

const CLAIM_KEY = 'openlive.voice.shortcutTab';
/** A tab in voice renews its claim this often... */
export const CLAIM_RENEW_MS = 5_000;
/** ...and a claim not renewed for this long is a closed or frozen tab's. */
export const CLAIM_STALE_MS = 15_000;

export interface ClaimStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): ClaimStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

interface Claim {
  tab: string;
  at: number;
}

function readClaim(store: ClaimStorage | null): Claim | null {
  try {
    const raw = store?.getItem(CLAIM_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Claim>;
    return typeof value.tab === 'string' && typeof value.at === 'number'
      ? { tab: value.tab, at: value.at }
      : null;
  } catch {
    return null;
  }
}

/** This tab is the one in voice that acts on shortcuts (it joined last): takes the claim. */
export function claimShortcutTab(
  tab: string,
  now: number = Date.now(),
  store: ClaimStorage | null = localStore(),
): void {
  try {
    store?.setItem(CLAIM_KEY, JSON.stringify({ tab, at: now }));
  } catch {
    // Storage full or blocked: this tab then acts alone, as without the claim.
  }
}

/** This tab left voice: gives the claim up if it is its own. */
export function releaseShortcutTab(tab: string, store: ClaimStorage | null = localStore()): void {
  try {
    if (readClaim(store)?.tab === tab) store?.removeItem(CLAIM_KEY);
  } catch {
    // Nothing to give up.
  }
}

/**
 * Whether this tab acts: it holds the claim, or nobody holds a fresh one (storage missing, or the
 * holder closed). A tab that renews its claim keeps it until another tab joins voice.
 */
export function actsOnShortcuts(
  tab: string,
  now: number = Date.now(),
  store: ClaimStorage | null = localStore(),
): boolean {
  const claim = readClaim(store);
  return !claim || claim.tab === tab || now - claim.at > CLAIM_STALE_MS;
}

/**
 * Applies a shortcut the way the in-page controls do: push-to-talk only while it is turned on
 * (like its key), mute only when the microphone can be muted, deafen always. Nothing happens out
 * of voice.
 */
export function applyVoiceShortcut(
  client: Pick<VoiceClient, 'getState' | 'setPttPressed' | 'setMuted' | 'setDeafened'>,
  shortcut: Pick<PayloadOf<'helper.voiceShortcut'>, 'action' | 'pressed'>,
): void {
  const state = client.getState();
  if (state.phase !== 'joined') return;
  switch (shortcut.action) {
    case 'pushToTalk':
      if (state.pushToTalk) client.setPttPressed(shortcut.pressed);
      return;
    case 'toggleMute':
      if (
        shortcut.pressed &&
        state.micError === null &&
        !state.serverMuted &&
        state.error === null
      ) {
        client.setMuted(!state.muted);
      }
      return;
    case 'toggleDeafen':
      if (shortcut.pressed) client.setDeafened(!state.deafened);
      return;
  }
}
