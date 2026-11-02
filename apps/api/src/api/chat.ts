// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { platformRoomLimits } from '../db/platform';
import { listRoomsForActor, roomRef } from '../db/rooms';
import { allowed, type AppEnv, authorize, loadSpace, requireUser, spaceRef } from './context';
import { roomLimits } from './settings';

// The text chat's REST side (docs/PROTOCOL.md 7.6). Messages travel on the room socket; this only
// serves the unread counts of the space's room list.

export const chat = new Hono<AppEnv>();

const roomStub = (env: Env, roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId));

/**
 * GET /api/spaces/:spaceId/chat/unread: `{ rooms: { [roomId]: number } }` for the open rooms with
 * text the caller may see; rooms without unread messages are left out.
 */
chat.get('/spaces/:spaceId/chat/unread', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.view', { space: spaceRef(space) }, { spaceId: space.id });
  const platform = await platformRoomLimits(c.env.DB);
  const list = (await listRoomsForActor(c.env.DB, space.id, user.id)).filter((room) => {
    const { capabilities } = roomLimits(space.settings, room.settings, platform);
    return capabilities?.text === true && allowed(actor, 'chat.read', { room: roomRef(room) });
  });
  const counts = await Promise.all(
    list.map(
      async (room) => [room.id, await roomStub(c.env, room.id).chatUnread(user.id)] as const,
    ),
  );
  return c.json({ rooms: Object.fromEntries(counts.filter(([, n]) => n > 0)) });
});
