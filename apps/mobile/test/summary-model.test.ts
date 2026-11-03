// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AWAY_MS,
  MAX_ITEMS,
  nonEmpty,
  serverSummary,
  type SpaceActivity,
  wasAway,
} from '../src/summary/model.ts';

const rooms = [
  { id: 'r1', name: 'geral' },
  { id: 'r2', name: 'jogos' },
];

const space = (over: Partial<SpaceActivity> = {}): SpaceActivity => ({
  spaceId: 's1',
  rooms,
  chat: { rooms: {}, mentions: {} },
  streams: [],
  ...over,
});

describe('wasAway', () => {
  it('needs a known last time and at least five minutes', () => {
    expect(wasAway(null, 1_000_000)).toBe(false);
    expect(wasAway(1_000_000, 1_000_000 + AWAY_MS - 1)).toBe(false);
    expect(wasAway(1_000_000, 1_000_000 + AWAY_MS)).toBe(true);
  });
});

describe('serverSummary', () => {
  it('lists streams newest first, then mentions, then the unread beyond the mentions', () => {
    const s = serverSummary('https://a', 'A', [
      space({
        streams: [
          { streamId: 'a', roomId: 'r1', userId: 'u1', userName: 'Ana', startedAt: 10 },
          { streamId: 'b', roomId: 'r2', userId: 'u2', userName: 'Bia', startedAt: 20 },
        ],
        chat: { rooms: { r1: 5, r2: 2 }, mentions: { r1: 3 } },
      }),
    ]);
    expect(
      s.items.map((i) => [i.kind, i.roomId, 'who' in i ? i.who : (i as { count: number }).count]),
    ).toEqual([
      ['stream', 'r2', 'Bia'],
      ['stream', 'r1', 'Ana'],
      ['mentions', 'r1', 3],
      ['unread', 'r1', 2],
      ['unread', 'r2', 2],
    ]);
    expect(s.more).toBe(0);
  });

  it('skips rooms the person cannot list and counts what does not fit', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x${i}`, 1]));
    const s = serverSummary('https://a', 'A', [
      space({
        rooms: [...rooms, ...Object.keys(many).map((id) => ({ id, name: id }))],
        chat: { rooms: { ...many, gone: 4 }, mentions: {} },
      }),
    ]);
    expect(s.items).toHaveLength(MAX_ITEMS);
    expect(s.more).toBe(9 - MAX_ITEMS);
    expect(s.items.some((i) => i.roomId === 'gone')).toBe(false);
  });

  it('never counts more mentions than unread messages (an older cap)', () => {
    const s = serverSummary('https://a', 'A', [
      space({ chat: { rooms: { r1: 2 }, mentions: { r1: 9 } } }),
    ]);
    expect(s.items).toEqual([expect.objectContaining({ kind: 'mentions', count: 2 })]);
  });

  it('nonEmpty drops the servers with nothing', () => {
    const empty = serverSummary('https://a', 'A', [space()]);
    const full = serverSummary('https://b', 'B', [
      space({ chat: { rooms: { r1: 1 }, mentions: {} } }),
    ]);
    expect(nonEmpty([empty, full]).map((x) => x.origin)).toEqual(['https://b']);
  });
});
