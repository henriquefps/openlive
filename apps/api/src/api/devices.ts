// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DeviceApproveResponse,
  DeviceCodeInfo,
  DeviceCodeResponse,
  DeviceList,
  DeviceTokenResponse,
} from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  approveCode,
  createDeviceCode,
  formatUserCode,
  listDevices,
  normalizeUserCode,
  pendingCode,
  pollDeviceCode,
  revokeDevice,
} from '../auth/devices';
import { appOrigin, configuredOrigins } from '../auth/origin';
import { consume } from '../auth/rate-limit';
import { ipHash } from '../auth/session';
import type { User } from '../db/users';
import { ApiError } from '../errors';
import { type AppEnv, authenticate, body, type Ctx } from './context';
import { id, name } from './schemas';

// Helper pairing and Settings > Devices (docs/PROTOCOL.md 11.1). The helper's two
// routes take no credentials; the others are for a signed-in person, never for a device token
// (a stolen helper token must not be able to pair more devices or revoke the real ones).

export const devices = new Hono<AppEnv>();

const MINUTE = 60 * 1000;
/** Pairing codes per IP: a helper needs one per pairing attempt. */
const CODES_PER_IP = { max: 10, windowMs: 10 * MINUTE };
/** Code lookups and approvals per person: enough to fix typos, far too few to guess codes. */
const LINK_ATTEMPTS = { max: 20, windowMs: 10 * MINUTE };

const os = z.enum(['linux', 'windows', 'macos']);
const arch = z.enum(['amd64', 'arm64']);
const helperVersion = z
  .string()
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/);
const label = z.string().trim().min(1).max(200);
const userCode = z.string().regex(/^[0-9A-Za-z]{3}-?[0-9A-Za-z]{3}$/);

// Receivers ignore unknown fields (docs/PROTOCOL.md 1): z.object strips them.
const codeRequest = z.object({ name: label.optional(), os, arch, helperVersion });
const tokenRequest = z.object({ deviceCode: z.string().min(1).max(128) });
const approveRequest = z.object({
  userCode,
  name,
  os: os.optional(),
  arch: arch.optional(),
  helperVersion: helperVersion.optional(),
});

/** The signed-in person, refused when the caller is a device. */
async function requirePerson(c: Ctx): Promise<User> {
  const { user, deviceId } = await authenticate(c);
  if (deviceId) throw new ApiError(403, 'forbidden');
  return user;
}

async function limit(c: Ctx, bucket: string, l: { max: number; windowMs: number }) {
  const wait = await consume(c.env.DB, [{ bucket, ...l }], Date.now());
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
}

/** POST /api/devices/code: the helper asks for a pairing code (RFC 8628 3.1). */
devices.post('/devices/code', async (c) => {
  const input = await body(c, codeRequest);
  const ip = await ipHash(c.req.raw, c.env);
  if (ip) await limit(c, `device_code:${ip}`, CODES_PER_IP);
  const origin = appOrigin(c.req.raw, c.env) ?? [...configuredOrigins(c.env)][0] ?? '';
  const code = await createDeviceCode(c.env.DB, input, Date.now());
  const verificationUri = `${origin}/link`;
  return c.json({
    ...code,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${code.userCode}`,
  } satisfies DeviceCodeResponse);
});

/** POST /api/devices/token: the helper polls (RFC 8628 3.4, 3.5). */
devices.post('/devices/token', async (c) => {
  const { deviceCode } = await body(c, tokenRequest);
  const result = await pollDeviceCode(c.env.DB, deviceCode, Date.now());
  switch (result.status) {
    case 'pending':
      throw new ApiError(400, 'authorization_pending');
    case 'slow_down':
      throw new ApiError(400, 'slow_down', { intervalMs: result.intervalMs });
    case 'expired':
      throw new ApiError(400, 'expired_token');
    case 'approved':
      c.header('Cache-Control', 'no-store');
      return c.json({
        deviceId: result.deviceId,
        userId: result.userId,
        deviceToken: result.deviceToken,
      } satisfies DeviceTokenResponse);
  }
});

/** GET /api/devices/code/:userCode: what the helper sent, for the /link confirmation. */
devices.get('/devices/code/:userCode', async (c) => {
  const user = await requirePerson(c);
  await limit(c, `device_link:${user.id}`, LINK_ATTEMPTS);
  const code = normalizeUserCode(c.req.param('userCode'));
  const pending = code ? await pendingCode(c.env.DB, code, Date.now()) : null;
  if (!pending) throw new ApiError(404, 'device_code_invalid');
  return c.json(pending satisfies DeviceCodeInfo);
});

/** POST /api/devices/approve: the signed-in person pairs the helper with their account. */
devices.post('/devices/approve', async (c) => {
  const user = await requirePerson(c);
  const input = await body(c, approveRequest);
  await limit(c, `device_link:${user.id}`, LINK_ATTEMPTS);
  const code = normalizeUserCode(input.userCode);
  const ok =
    code !== null &&
    (await approveCode(
      c.env.DB,
      user.id,
      code,
      { name: input.name, os: input.os, arch: input.arch, helperVersion: input.helperVersion },
      Date.now(),
    ));
  if (!ok || code === null) throw new ApiError(404, 'device_code_invalid');
  return c.json({ userCode: formatUserCode(code) } satisfies DeviceApproveResponse);
});

/** GET /api/me/devices: Settings > Devices. */
devices.get('/me/devices', async (c) => {
  const user = await requirePerson(c);
  return c.json({ devices: await listDevices(c.env.DB, user.id) } satisfies DeviceList);
});

/** DELETE /api/me/devices/:deviceId: revokes the token and closes the device's sockets (4001). */
devices.delete('/me/devices/:deviceId', async (c) => {
  const user = await requirePerson(c);
  const deviceId = c.req.param('deviceId');
  if (!id.safeParse(deviceId).success) throw new ApiError(404, 'device_not_found', {});
  if (!(await revokeDevice(c.env.DB, user.id, deviceId, Date.now()))) {
    throw new ApiError(404, 'device_not_found', { deviceId });
  }
  const hub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
  const rooms = await hub.takeDeviceRooms(deviceId);
  await Promise.all([
    hub.revokeDevice(deviceId),
    ...rooms.map((roomId) => c.env.ROOM.get(c.env.ROOM.idFromName(roomId)).revokeDevice(deviceId)),
  ]);
  return c.body(null, 204);
});
