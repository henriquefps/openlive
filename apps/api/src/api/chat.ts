// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { platformRoomLimits } from '../db/platform';
import { listRoomsForActor, roomRef } from '../db/rooms';
import { allowed, type AppEnv, authorize, loadSpace, requireUser, spaceRef } from './context';
import { isBreakerOpenError } from '../do/breaker';
import { roomLimits } from './settings';

// The text chat's REST side (docs/PROTOCOL.md 7.6). Messages travel on the room socket; this only
// serves the unread counts of the space's room list.

export const chat = new Hono<AppEnv>();

const roomStub = (env: Env, roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId));

/** A room whose circuit breaker is open counts as nothing unread, not as a failed list. */
async function countsOf(
  room: ReturnType<typeof roomStub>,
  userId: string,
): Promise<{ unread: number; mentions: number }> {
  try {
    return await room.chatCounts(userId);
  } catch (error) {
    if (isBreakerOpenError(error)) return { unread: 0, mentions: 0 };
    throw error;
  }
}

/**
 * GET /api/spaces/:spaceId/chat/unread: `{ rooms: { [roomId]: number }, mentions: { [roomId]:
 * number } }` for the open rooms with text the caller may see; rooms without unread messages (or
 * without unread mentions) are left out. `mentions` counts the unread messages that mention the
 * caller.
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
    list.map(async (room) => [room.id, await countsOf(roomStub(c.env, room.id), user.id)] as const),
  );
  const only = (pick: (n: { unread: number; mentions: number }) => number) =>
    Object.fromEntries(counts.flatMap(([id, n]) => (pick(n) > 0 ? [[id, pick(n)] as const] : [])));
  return c.json({ rooms: only((n) => n.unread), mentions: only((n) => n.mentions) });
});
