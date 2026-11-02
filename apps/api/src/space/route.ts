// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { isAllowedOrigin } from '../auth/origin';
import { errorResponse } from '../errors';
import { connectRequest } from '../room/connect';
import { resolveSocketIdentity } from '../room/identity';
import { presenceAccess } from './access';
import type { SpaceConnectContext } from './types';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /ws/spaces/:spaceId: the space's room presence for its sidebar (PROTOCOL.md 7.8). Web tabs
 * (session cookie) and the mobile app (ticket, 11.6); the caller must be able to view the space.
 * Which restricted rooms they see is decided here and handed to the SpaceDO with the socket.
 */
export async function spaceSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse(c, 426, 'invalid_message', { path: '' });
  }
  // Cross-site WebSocket hijacking: see room/route.ts.
  const origin = c.req.header('Origin');
  if (origin && !isAllowedOrigin(origin, c.req.raw, c.env)) {
    return errorResponse(c, 403, 'origin_not_allowed');
  }
  const identity = await resolveSocketIdentity(c.req.raw, c.env);
  if (!identity) return errorResponse(c, 401, 'unauthenticated');
  // The sidebar is the web app's; a helper has no use for it.
  if (identity.deviceId) return errorResponse(c, 403, 'forbidden');

  const spaceId = c.req.param('spaceId') ?? '';
  if (!ID_PATTERN.test(spaceId)) return errorResponse(c, 404, 'space_not_found', { spaceId });
  const result = await presenceAccess(c.env.DB, spaceId, identity.userId);
  if (!result.ok) {
    const params = result.status === 404 ? { spaceId } : undefined;
    return errorResponse(c, result.status, result.code, params);
  }
  const context: SpaceConnectContext = {
    userId: identity.userId,
    spaceId,
    access: result.access,
  };
  if (identity.appTokenId) {
    context.appTokenId = identity.appTokenId;
    // Remembered so that revoking the app token can close this socket (PROTOCOL.md 11.6).
    await c.env.USER_HUB.get(c.env.USER_HUB.idFromName(identity.userId)).appJoined(
      identity.appTokenId,
      'space',
      spaceId,
    );
  }
  const stub = c.env.SPACE.get(c.env.SPACE.idFromName(spaceId));
  return stub.fetch(connectRequest(context));
}
