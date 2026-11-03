// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatActivity, RecentStream } from '@openlive/client';

// "What happened" when the app opens after some time away (no push): per
// server, the streams that started, the mentions and the unread messages, each leading to its
// room. Pure, so the rules are tested without a phone.

/** Away for longer than this, the app says what happened. */
export const AWAY_MS = 5 * 60_000;
/** At most this many lines per server; the rest is a count. */
export const MAX_ITEMS = 6;

export function wasAway(lastSeen: number | null, now: number): boolean {
  return lastSeen !== null && now - lastSeen >= AWAY_MS;
}

/** What one space of a server has, as the API answers. */
export interface SpaceActivity {
  spaceId: string;
  rooms: readonly { id: string; name: string }[];
  chat: ChatActivity;
  streams: readonly RecentStream[];
}

export type SummaryItem =
  | { kind: 'stream'; spaceId: string; roomId: string; roomName: string; who: string; at: number }
  | { kind: 'mentions'; spaceId: string; roomId: string; roomName: string; count: number }
  | { kind: 'unread'; spaceId: string; roomId: string; roomName: string; count: number };

export interface ServerSummary {
  origin: string;
  serverName: string;
  items: SummaryItem[];
  /** Lines left out beyond MAX_ITEMS. */
  more: number;
}

/** The lines of one server: streams (newest first), then mentions, then the unread beyond them. */
export function serverSummary(
  origin: string,
  serverName: string,
  spaces: readonly SpaceActivity[],
): ServerSummary {
  const streams: SummaryItem[] = [];
  const mentions: SummaryItem[] = [];
  const unread: SummaryItem[] = [];
  for (const space of spaces) {
    const names = new Map(space.rooms.map((r) => [r.id, r.name]));
    for (const s of space.streams) {
      const roomName = names.get(s.roomId);
      if (roomName === undefined) continue;
      streams.push({
        kind: 'stream',
        spaceId: space.spaceId,
        roomId: s.roomId,
        roomName,
        who: s.userName,
        at: s.startedAt,
      });
    }
    for (const [roomId, total] of Object.entries(space.chat.rooms)) {
      const roomName = names.get(roomId);
      if (roomName === undefined || total <= 0) continue;
      const m = Math.min(space.chat.mentions[roomId] ?? 0, total);
      const base = { spaceId: space.spaceId, roomId, roomName };
      if (m > 0) mentions.push({ kind: 'mentions', ...base, count: m });
      if (total > m) unread.push({ kind: 'unread', ...base, count: total - m });
    }
  }
  streams.sort((a, b) => (b.kind === 'stream' && a.kind === 'stream' ? b.at - a.at : 0));
  const all = [...streams, ...mentions, ...unread];
  return {
    origin,
    serverName,
    items: all.slice(0, MAX_ITEMS),
    more: Math.max(0, all.length - MAX_ITEMS),
  };
}

/** Servers with something to say, in the order given. */
export const nonEmpty = (servers: readonly ServerSummary[]): ServerSummary[] =>
  servers.filter((s) => s.items.length > 0);

/** The time of a stream's start in the phone's language, "20:15". */
export function clock(at: number, locale: string): string {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
