// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { ApiError } from '../errors';
import { roomAccess } from '../room/access';
import { thumbnailKey } from '../room/thumbnails';
import { type AppEnv, authenticate } from './context';
import { id } from './schemas';

// Serving stream thumbnails (docs/PROTOCOL.md 11.3). A thumbnail shows the screen,
// so it follows the stream's access rule: the caller must be allowed into the stream's room
// (can(room.view), the same check as the room socket) on every request. Nothing is public: the
// bucket is private, the URL is not a capability, and the cache is the browser's own.

export const thumbnails = new Hono<AppEnv>();

/** GET /api/streams/:streamId/thumbnail: the latest JPEG, or 404 for anything not visible. */
thumbnails.get('/streams/:streamId/thumbnail', async (c) => {
  const { user } = await authenticate(c);
  const streamId = c.req.param('streamId');
  // One answer for "no such stream", "no thumbnail" and "not yours to see": ids cannot be probed.
  const notFound = () => new ApiError(404, 'not_found');
  if (!id.safeParse(streamId).success) throw notFound();
  const object = await c.env.THUMBNAILS.get(thumbnailKey(streamId));
  const roomId = object?.customMetadata?.['roomId'];
  if (!object || !roomId) throw notFound();
  const access = await roomAccess(c.env.DB, roomId, user.id);
  if (!access.ok) throw notFound();
  const headers = new Headers({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=10',
    ETag: object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
  });
  const match = c.req.header('If-None-Match');
  if (match && match.split(',').some((t) => t.trim() === object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { status: 200, headers });
});
