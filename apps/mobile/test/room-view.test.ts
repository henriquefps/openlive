// SPDX-License-Identifier: AGPL-3.0-only
import type { Member, StreamInfo } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import {
  endedText,
  roomNotice,
  sortedMembers,
  streamCards,
  thumbnailUrl,
} from '../src/lib/room-view.ts';

const member = (userId: string, displayName: string): Member => ({
  userId,
  displayName,
  role: 'member',
  canStream: true,
});

const stream = (streamId: string, userId: string, startedAt: number): StreamInfo => ({
  streamId,
  userId,
  deviceId: 'd',
  source: { kind: 'screen', label: 'Screen 1' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt,
  viewerLimit: 5,
  viewerCount: 1,
});

describe('streamCards', () => {
  it('orders by start, names the streamer and prefers the latest viewer count', () => {
    const cards = streamCards(
      [stream('b', 'u2', 20), stream('a', 'u1', 10), stream('c', 'ghost', 30)],
      [member('u1', 'Ana'), member('u2', 'Bia')],
      { a: { used: 4 } },
    );
    expect(cards.map((c) => [c.streamId, c.streamer, c.viewers])).toEqual([
      ['a', 'Ana', 4],
      ['b', 'Bia', 1],
      ['c', null, 1],
    ]);
    expect(cards[0]).toMatchObject({ preset: 'game', source: 'Screen 1', viewerLimit: 5 });
  });
});

describe('stream card photo and thumbnail', () => {
  it('carries the streamer photo and the thumbnail version', () => {
    const [card] = streamCards(
      [{ ...stream('a', 'u1', 10), thumbnailAt: 99 }],
      [{ ...member('u1', 'Ana'), avatarUrl: 'https://x/a.png' }],
    );
    expect(card).toMatchObject({ streamerAvatar: 'https://x/a.png', thumbnailAt: 99 });
    const [bare] = streamCards([stream('a', 'u9', 10)], []);
    expect(bare).toMatchObject({ streamerAvatar: null, thumbnailAt: null });
  });
  it('builds the thumbnail URL on the instance', () => {
    expect(thumbnailUrl('https://o.example/', 'a b', 7)).toBe(
      'https://o.example/api/streams/a%20b/thumbnail?v=7',
    );
  });
});

describe('members', () => {
  it('puts the reader first and the rest by name', () => {
    const list = sortedMembers(
      [member('u2', 'Zed'), member('me', 'Me'), member('u1', 'Ana')],
      'me',
    );
    expect(list.map((m) => m.displayName)).toEqual(['Me', 'Ana', 'Zed']);
  });
});

describe('roomNotice', () => {
  it('says nothing while open', () => {
    expect(roomNotice({ status: 'open', ended: null, quotaExceeded: false })).toBeNull();
  });
  it('reports connecting and reconnecting (with the quota flag)', () => {
    expect(roomNotice({ status: 'connecting', ended: null, quotaExceeded: false })).toEqual({
      kind: 'connecting',
    });
    expect(roomNotice({ status: 'reconnecting', ended: null, quotaExceeded: true })).toEqual({
      kind: 'reconnecting',
      quota: true,
    });
  });
  it('reports why it ended', () => {
    const end = { kind: 'forbidden' } as const;
    expect(roomNotice({ status: 'ended', ended: end, quotaExceeded: false })).toEqual({
      kind: 'ended',
      end,
    });
  });
});

describe('endedText', () => {
  it('maps each end to a translation key and what to offer', () => {
    expect(endedText({ kind: 'kicked', reason: 'banned' }).key).toBe('room.kickReason.banned');
    expect(endedText({ kind: 'closed', reason: 'expired' }).key).toBe('room.closeReason.expired');
    expect(endedText({ kind: 'replaced' }).retry).toBe(true);
    expect(endedText({ kind: 'unauthenticated' }).signIn).toBe(true);
  });
});
