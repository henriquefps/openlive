// SPDX-License-Identifier: AGPL-3.0-only
import { INITIAL_SPACE_PRESENCE, SpacePresenceConnection, type Room } from '@openlive/client';
import type { RoomPresence } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import {
  activity,
  markRoomRead,
  namesWithMore,
  roomRows,
  streamerNames,
} from '../src/lib/presence.ts';

const room = (id: string, archivedAt: number | null = null): Room =>
  ({ id, name: id, archivedAt, kind: 'fixed' }) as Room;

const presence = (roomId: string, voice: number, live: number): RoomPresence => ({
  roomId,
  voice: Array.from({ length: voice }, (_, i) => ({
    userId: `u${i}`,
    displayName: `V${i}`,
    muted: false,
    deafened: false,
  })),
  live: Array.from({ length: live }, (_, i) => ({
    userId: `l${i}`,
    displayName: `L${i}`,
    streamId: `st${i}`,
  })),
});

describe('roomRows', () => {
  it('keeps the API order, drops archived rooms and fills presence and unread', () => {
    const rows = roomRows(
      [room('a'), room('b', 5), room('c')],
      { c: presence('c', 2, 1) },
      { a: 3 },
    );
    expect(rows.map((r) => r.room.id)).toEqual(['a', 'c']);
    expect(rows[0]).toMatchObject({ voice: [], live: [], unread: 3 });
    expect(rows[1]?.voice).toHaveLength(2);
    expect(rows[1]?.live).toHaveLength(1);
    expect(rows[1]?.unread).toBe(0);
  });

  it('sums the activity of a space', () => {
    const rows = roomRows(
      [room('a'), room('c')],
      { a: presence('a', 1, 0), c: presence('c', 2, 1) },
      { c: 4 },
    );
    expect(activity(rows)).toEqual({ live: 1, voice: 3, unread: 4 });
  });
});

describe('helpers', () => {
  it('cuts a list of names and counts the rest', () => {
    expect(namesWithMore(['a', 'b', 'c', 'd'], 3)).toEqual({ shown: ['a', 'b', 'c'], more: 1 });
    expect(namesWithMore(['a'], 3)).toEqual({ shown: ['a'], more: 0 });
  });

  it('skips streamers without a name yet', () => {
    expect(
      streamerNames([
        { userId: '1', streamId: 's1', displayName: 'Ana' },
        { userId: '2', streamId: 's2' },
      ]),
    ).toEqual(['Ana']);
  });

  it('marks a room read without touching the others', () => {
    const before = { a: 3, b: 1 };
    expect(markRoomRead(before, 'a')).toEqual({ b: 1 });
    expect(before).toEqual({ a: 3, b: 1 });
  });
});

describe('the space socket the screen subscribes to', () => {
  it('starts connecting with no rooms', () => {
    expect(INITIAL_SPACE_PRESENCE).toMatchObject({ status: 'connecting', rooms: {} });
    expect(typeof SpacePresenceConnection).toBe('function');
  });
});
