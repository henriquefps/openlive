// SPDX-License-Identifier: AGPL-3.0-only
import {
  INITIAL_CHAT,
  INITIAL_SPACE_PRESENCE,
  INITIAL_STATE,
  type ChatState,
  type RoomState,
} from '@openlive/client';
import type { RoomPresence, You } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, PresenceSnapshot, RoomSnapshot } from '../src/lib/cache.ts';
import {
  chatSnapshot,
  chatView,
  presenceSnapshot,
  presenceView,
  roomSnapshot,
  roomView,
} from '../src/lib/snapshots.ts';

const NOW = 1_800_000_000_000;
const you = { userId: 'u1', permissions: {} } as unknown as You;
const presence = (roomId: string): RoomPresence =>
  ({ roomId, voice: [{ userId: 'u2', displayName: 'Bia' }], live: [] }) as unknown as RoomPresence;

describe('space presence', () => {
  const seed: PresenceSnapshot = { rooms: { r1: presence('r1') }, savedAt: NOW - 1000 };

  it('shows the saved snapshot until the live one arrives, then the live one', () => {
    const connecting = { ...INITIAL_SPACE_PRESENCE };
    expect(presenceView(connecting, seed)).toEqual({ rooms: seed.rooms, stale: true });
    const open = { ...INITIAL_SPACE_PRESENCE, status: 'open' as const, rooms: {} };
    expect(presenceView(open, seed)).toEqual({ rooms: {}, stale: false });
  });

  it('keeps showing the saved one while reconnecting, with nothing saved shows nothing', () => {
    const reconnecting = { ...INITIAL_SPACE_PRESENCE, status: 'reconnecting' as const };
    expect(presenceView(reconnecting, seed).rooms).toBe(seed.rooms);
    expect(presenceView(INITIAL_SPACE_PRESENCE, undefined)).toEqual({ rooms: {}, stale: false });
  });

  it('only a live (open) snapshot is saved', () => {
    expect(presenceSnapshot(INITIAL_SPACE_PRESENCE, NOW)).toBeNull();
    const open = {
      ...INITIAL_SPACE_PRESENCE,
      status: 'open' as const,
      rooms: { r1: presence('r1') },
    };
    expect(presenceSnapshot(open, NOW)).toEqual({ rooms: open.rooms, savedAt: NOW });
  });
});

describe('room', () => {
  const seed: RoomSnapshot = {
    you,
    room: null,
    settings: null,
    members: [{ userId: 'u2', displayName: 'Bia' } as never],
    streams: [],
    viewers: {},
    savedAt: NOW - 1000,
  };

  it('seeds members before the welcome and replaces them with the live ones', () => {
    const before = roomView(INITIAL_STATE, seed);
    expect(before.stale).toBe(true);
    expect(before.state.members).toBe(seed.members);
    expect(before.state.status).toBe('connecting');

    const live: RoomState = { ...INITIAL_STATE, status: 'open', you, members: [] };
    const after = roomView(live, seed);
    expect(after.stale).toBe(false);
    expect(after.state.members).toEqual([]);
  });

  it('keeps the live members through a reconnect', () => {
    const live: RoomState = { ...INITIAL_STATE, status: 'reconnecting', you, members: [] };
    expect(roomView(live, seed)).toEqual({ state: live, stale: false });
  });

  it('saves only after the welcome, while open', () => {
    expect(roomSnapshot(INITIAL_STATE, NOW)).toBeNull();
    expect(roomSnapshot({ ...INITIAL_STATE, status: 'reconnecting', you }, NOW)).toBeNull();
    expect(roomSnapshot({ ...INITIAL_STATE, status: 'open', you }, NOW)?.you).toBe(you);
  });
});

describe('chat', () => {
  const seed: ChatSnapshot = {
    messages: [
      { id: 'm_1', userId: 'u2', authorName: 'Bia', text: 'oi', createdAt: 1, mentions: [] },
    ],
    hasMore: true,
    lastReadId: 'm_1',
    retentionDays: 30,
    quick: false,
    savedAt: NOW,
  };

  it('shows the saved messages until the first live page, then the live ones', () => {
    const before = chatView(INITIAL_CHAT, false, seed);
    expect(before.stale).toBe(true);
    expect(before.state.status).toBe('ready');
    expect(before.state.messages).toBe(seed.messages);
    const loading: ChatState = { ...INITIAL_CHAT, status: 'loading' };
    expect(chatView(loading, true, seed).state.messages).toBe(seed.messages);

    const live: ChatState = { ...INITIAL_CHAT, status: 'ready', messages: [] };
    expect(chatView(live, true, seed)).toEqual({ state: live, stale: false });
  });

  it('shows nothing when the welcome says the chat is off', () => {
    expect(chatView(INITIAL_CHAT, true, seed).stale).toBe(false);
  });

  const first = seed.messages[0] as ChatSnapshot['messages'][number];

  it('saves confirmed messages only, with the retention and kind of the room', () => {
    const live: ChatState = {
      ...INITIAL_CHAT,
      status: 'ready',
      messages: [
        { ...first, clientId: 'c1' },
        { ...first, id: 'pending_c2', clientId: 'c2', pending: true },
        { ...first, id: 'm_3', failed: { code: 'internal_error' } },
      ],
    };
    const snap = chatSnapshot(
      live,
      { settings: { chatRetentionDays: 0 } as never, room: null },
      NOW,
    );
    expect(snap?.messages.map((m) => m.id)).toEqual(['m_1']);
    expect(snap?.messages[0]).not.toHaveProperty('clientId');
    expect(snap?.retentionDays).toBe(0);
    expect(chatSnapshot(INITIAL_CHAT, { settings: null, room: null }, NOW)).toBeNull();
  });
});
