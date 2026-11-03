// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { listRoomsForActor, roomRef } from '../db/rooms';
import { ApiError } from '../errors';
import { allowed, type AppEnv, authorize, loadSpace, requireUser, spaceRef } from './context';

// What the mobile app (no push) tells you when it opens (docs/PROTOCOL.md 11.7): the streams that
// started in the space while you were away.

export const recent = new Hono<AppEnv>();

/** At most this many starts come back, newest first. */
export const RECENT_STREAMS_MAX = 20;
/** `since` further back than this is read as this (the table keeps a week). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const query = z.object({ since: z.coerce.number().int().nonnegative() });

/**
 * GET /api/spaces/:spaceId/streams/recent?since=<ms>: `{ streams: [{ streamId, roomId, userId,
 * userName, startedAt }] }`, the streams that started after `since` in the open rooms the caller
 * may see (a restricted room only for those with access), newest first, at most 20. One D1 read.
 */
recent.get('/spaces/:spaceId/streams/recent', async (c) => {
  const user = await requireUser(c);
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(400, 'invalid_message', { path: '/since' });
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.view', { space: spaceRef(space) }, { spaceId: space.id });
  const since = Math.max(parsed.data.since, Date.now() - RECENT_WINDOW_MS);
  const visible = new Set(
    (await listRoomsForActor(c.env.DB, space.id, user.id))
      .filter((room) => allowed(actor, 'room.view', { room: roomRef(room) }))
      .map((room) => room.id),
  );
  const { results } = await c.env.DB.prepare(
    `SELECT s.stream_id, s.room_id, s.user_id, u.display_name, s.started_at
     FROM stream_starts s JOIN users u ON u.id = s.user_id
     WHERE s.space_id = ? AND s.started_at > ?
     ORDER BY s.started_at DESC LIMIT ?`,
  )
    .bind(space.id, since, RECENT_STREAMS_MAX * 3)
    .all<{
      stream_id: string;
      room_id: string;
      user_id: string;
      display_name: string;
      started_at: number;
    }>();
  const streams = results
    .filter((r) => visible.has(r.room_id) && r.user_id !== user.id)
    .slice(0, RECENT_STREAMS_MAX)
    .map((r) => ({
      streamId: r.stream_id,
      roomId: r.room_id,
      userId: r.user_id,
      userName: r.display_name,
      startedAt: r.started_at,
    }));
  return c.json({ streams });
});
