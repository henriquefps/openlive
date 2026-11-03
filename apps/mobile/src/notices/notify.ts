// SPDX-License-Identifier: AGPL-3.0-only
import { type NoticeEvent, type NoticeText, Notifier, NoticeSettingsStore } from '@openlive/client';
import { playCue } from '../audio/index.ts';
import { voicePrefsStore } from '../voice/store.ts';
import { PhoneSounds } from './sounds.ts';
import { toasts, type ToastKind } from './toasts.ts';

// The app's notices (the web's notices/, shared through @openlive/client): a short cue and a toast
// for what happens while the app is open. One notifier for the app; the watchers (watchers.tsx)
// feed it. The sound settings are kept on the phone (`openlive.notices`, like the voice prefs) and
// are the web's model: "mute all", the volume and each kind on or off.

export const noticeSettings = new NoticeSettingsStore(() => voicePrefsStore);

const sounds = new PhoneSounds(playCue);

/** Alerts stand out from the rest. */
const WARNING: ReadonlySet<NoticeEvent> = new Set(['streamDropped', 'streamUnstable', 'queueSlot']);

/** Where a notice's toast leads when tapped (set by the navigator). */
export interface RoomTarget {
  origin: string;
  spaceId: string;
  roomId: string;
  roomName: string;
}

let openRoom: ((target: RoomTarget) => void) | null = null;

/** The navigator registers how a tapped toast opens a room. */
export function setRoomOpener(opener: ((target: RoomTarget) => void) | null): void {
  openRoom = opener;
}

// The tap of the notice being notified now: the Notifier's toast callback runs synchronously.
let pending: RoomTarget | undefined;

const notifier = new Notifier({
  settings: noticeSettings.get,
  sounds,
  toast: (event, text) => {
    const target = pending;
    toasts.show({
      kind: WARNING.has(event) ? 'warning' : 'info',
      title: text.title,
      description: text.description,
      onPress: target && openRoom ? () => openRoom?.(target) : undefined,
    });
  },
  // A phone needs no first tap before it may play a sound.
  interacted: () => true,
});

/** The same notice twice within this long (two sockets of one room) counts once. */
const DEDUPE_MS = 2_000;
const recent = new Map<string, number>();

/** Says a notice: its cue (if turned on) and its toast. */
export function notify(
  event: NoticeEvent,
  text: NoticeText,
  options: { target?: RoomTarget; key?: string; now?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
  const key = `${event}|${options.key ?? text.title}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  if (recent.size > 50) {
    for (const [k, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(k);
  }
  pending = options.target;
  try {
    return notifier.notify(event, text);
  } finally {
    pending = undefined;
  }
}

/** A toast with no cue: a notice that is not one of the web's events (voice ended). */
export function toast(
  title: string,
  options: { description?: string | undefined; kind?: ToastKind } = {},
): void {
  toasts.show({ title, ...options });
}

// The room whose chat is on screen: its mentions are already in front of the reader.
let chatOpen: string | null = null;
export const setChatOpen = (roomId: string | null): void => {
  chatOpen = roomId;
};
export const isChatOpen = (roomId: string): boolean => chatOpen === roomId;
