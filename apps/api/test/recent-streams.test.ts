// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, fixedRoom, migrate, world, type World } from './api-helpers';
import { RECENT_STREAMS_MAX } from '../src/api/recent';

// GET /spaces/:spaceId/streams/recent (docs/PROTOCOL.md 11.7): the streams that started while the
// mobile app was away, in the rooms the caller may see.

beforeAll(migrate);

const MIN = 60_000;

async function start(w: World, roomId: string, userId: string, startedAt: number, id?: string) {
  await env.DB.prepare(
    `INSERT INTO stream_starts (stream_id, space_id, room_id, user_id, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id ?? `st_${crypto.randomUUID().slice(0, 8)}`, w.spaceId, roomId, userId, startedAt)
    .run();
}

const recent = (w: World, user: string, since: number) =>
  call('GET', `/spaces/${w.spaceId}/streams/recent?since=${since}`, user);

describe('recent stream starts', () => {
  it('lists the starts after `since`, newest first, with the streamer and the room', async () => {
    const w = await world();
    const room = await fixedRoom(w);
    const now = Date.now();
    await start(w, room, w.admin, now - 50 * MIN, 'st_old');
    await start(w, room, w.admin, now - 20 * MIN, 'st_a');
    await start(w, room, w.owner, now - 10 * MIN, 'st_b');
    const res = await recent(w, w.member, now - 30 * MIN);
    expect(res.status).toBe(200);
    expect(res.body.streams).toEqual([
      expect.objectContaining({ streamId: 'st_b', roomId: room, userId: w.owner }),
      expect.objectContaining({ streamId: 'st_a', roomId: room, userId: w.admin }),
    ]);
    expect(res.body.streams[0]).toEqual({
      streamId: 'st_b',
      roomId: room,
      userId: w.owner,
      userName: expect.any(String),
      startedAt: now - 10 * MIN,
    });
  });

  it('leaves out your own streams and restricted rooms you cannot see', async () => {
    const w = await world();
    const open = await fixedRoom(w);
    const restricted = await fixedRoom(w, { visibility: 'restricted' });
    const now = Date.now();
    await start(w, open, w.member, now - MIN, 'st_mine');
    await start(w, open, w.owner, now - MIN, 'st_open');
    await start(w, restricted, w.owner, now - MIN, 'st_restricted');
    const ids = async (user: string) =>
      (await recent(w, user, now - 5 * MIN)).body.streams.map(
        (s: { streamId: string }) => s.streamId,
      );
    expect(await ids(w.member)).toEqual(['st_open']);
    expect((await ids(w.admin)).sort()).toEqual(['st_mine', 'st_open', 'st_restricted']);
  });

  it('answers 404 to someone outside the space and 400 to a bad `since`', async () => {
    const w = await world();
    expect((await recent(w, w.outsider, 0)).status).toBe(404);
    const bad = await call('GET', `/spaces/${w.spaceId}/streams/recent?since=abc`, w.member);
    expect(bad).toEqual({ status: 400, body: { code: 'invalid_message', path: '/since' } });
  });

  it('is bounded: at most 20 starts, and nothing older than a week', async () => {
    const w = await world();
    const room = await fixedRoom(w);
    const now = Date.now();
    for (let i = 0; i < RECENT_STREAMS_MAX + 5; i += 1) {
      await start(w, room, w.owner, now - (i + 1) * MIN);
    }
    await start(w, room, w.owner, now - 8 * 24 * 60 * MIN, 'st_ancient');
    const res = await recent(w, w.member, 0);
    expect(res.body.streams).toHaveLength(RECENT_STREAMS_MAX);
    expect(res.body.streams.map((s: { streamId: string }) => s.streamId)).not.toContain(
      'st_ancient',
    );
  });
});
