// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceArch, DeviceOs } from '@openlive/protocol';
import type { Context } from 'hono';
import { isAllowedOrigin } from '../auth/origin';
import { errorResponse } from '../errors';
import { connectRequest } from '../room/connect';
import { resolveSocketIdentity } from '../room/identity';
import type { HubConnectContext, HubDevice } from './types';

/**
 * GET /ws/hub: the caller's own UserHubDO (PROTOCOL.md 2, 8). Web tabs authenticate with the
 * session cookie, helpers with their device token, the mobile app with a ticket (11.6); nobody
 * can reach another user's hub.
 */
export async function hubSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
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

  const context: HubConnectContext = { userId: identity.userId };
  if (identity.deviceId) {
    context.deviceId = identity.deviceId;
    context.device = await deviceOf(c.env.DB, identity.userId, identity.deviceId);
  }
  if (identity.appTokenId) context.appTokenId = identity.appTokenId;
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(identity.userId));
  return stub.fetch(connectRequest(context));
}

/**
 * The paired device's name and platform. A device token always has a row; the development
 * identity (DEV_DEVICE_HEADER) may name a device that was never paired, which gets placeholders.
 */
async function deviceOf(db: D1Database, userId: string, deviceId: string): Promise<HubDevice> {
  const row = await db
    .prepare(
      `SELECT name, os, arch FROM devices
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .bind(deviceId, userId)
    .first<{ name: string; os: DeviceOs; arch: DeviceArch }>();
  return row ?? { name: deviceId, os: 'linux', arch: 'amd64' };
}
