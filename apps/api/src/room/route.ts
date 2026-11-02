// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { isAllowedOrigin } from '../auth/origin';
import { errorResponse } from '../errors';
import { roomAccess } from './access';
import { connectRequest } from './connect';
import { resolveSocketIdentity } from './identity';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /ws/rooms/:roomId: authenticate (session cookie, a helper's device token or the mobile
 * app's ticket), check
 * can(actor, 'room.view'), then hand the socket to the room's RoomDO. A refused upgrade gets an HTTP error with an ErrorPayload body (PROTOCOL.md 2).
 */
export async function roomSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse(c, 426, 'invalid_message', { path: '' });
  }
  // Cross-site WebSocket hijacking: a browser always sends Origin on the upgrade, so a foreign
  // one is refused before the session cookie is looked at.
  const origin = c.req.header('Origin');
  if (origin && !isAllowedOrigin(origin, c.req.raw, c.env)) {
    return errorResponse(c, 403, 'origin_not_allowed');
  }
  const identity = await resolveSocketIdentity(c.req.raw, c.env);
  if (!identity) return errorResponse(c, 401, 'unauthenticated');

  const roomId = c.req.param('roomId') ?? '';
  if (!ID_PATTERN.test(roomId)) return errorResponse(c, 404, 'room_not_found', { roomId });
  const access = await roomAccess(c.env.DB, roomId, identity.userId);
  if (!access.ok) {
    const params = access.status === 401 ? undefined : { roomId };
    return errorResponse(c, access.status, access.code, params);
  }

  const { deviceId, appTokenId } = identity;
  const hub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(identity.userId));
  // Remembered so that revoking the device or the app token can close this socket (PROTOCOL.md
  // 11.1, 11.6).
  if (deviceId) await hub.deviceJoinedRoom(deviceId, roomId);
  if (appTokenId) await hub.appJoined(appTokenId, 'room', roomId);
  const stub = c.env.ROOM.get(c.env.ROOM.idFromName(roomId));
  return stub.fetch(
    connectRequest({
      ...access.context,
      ...(deviceId ? { deviceId } : {}),
      ...(appTokenId ? { appTokenId } : {}),
    }),
  );
}
