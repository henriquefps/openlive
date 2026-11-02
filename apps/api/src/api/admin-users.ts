// SPDX-License-Identifier: AGPL-3.0-only
import { KickReason } from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { listDevices } from '../auth/devices';
import { banIdentityStatements } from '../auth/bans';
import {
  activeSessions,
  chatRoomsOf,
  decodeCursor,
  deletionStatements,
  getUserSummary,
  listUsers,
  otherAdmins,
  ownedSpaces,
  recentAudit,
  roomsOfUser,
  USER_FILTERS,
} from '../db/admin-users';
import { auditStatement } from '../db/audit';
import { avatarKey } from '../db/avatars';
import { ApiError } from '../errors';
import type { UserStreamInfo } from '../room/types';
import { platformAdmin } from './admin';
import { type AppEnv, body, type Ctx } from './context';
import { id } from './schemas';

// Platform user management: every account on the instance, the spaces
// it belongs to, and a platform-wide ban, sign-out and deletion. Only the platform admin, through
// can(); every change is audited. The admin sees metadata, never stream content or IPs.

export const adminUsers = new Hono<AppEnv>();

const listQuery = z.object({
  query: z.string().max(200).default(''),
  filter: z.enum(USER_FILTERS).default('all'),
  cursor: z.string().max(100).optional(),
});

/** GET /api/admin/users?query=&filter=all|no_space|banned|admins&cursor=: newest first, 50 a page. */
adminUsers.get('/admin/users', async (c) => {
  await platformAdmin(c, 'platform.user.view', {});
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    throw new ApiError(400, 'invalid_message', { path: path.map((p) => `/${String(p)}`).join('') });
  }
  const { query, filter, cursor } = parsed.data;
  const at = cursor === undefined ? null : decodeCursor(cursor);
  if (cursor !== undefined && at === null) {
    throw new ApiError(400, 'invalid_message', { path: '/cursor' });
  }
  return c.json(await listUsers(c.env.DB, { query, filter, cursor: at }, Date.now()));
});

/** The target account (banned or not) after can(), or 404 user_not_found. */
async function target(
  c: Ctx,
  action: 'platform.user.view' | 'platform.user.ban' | 'platform.user.delete',
) {
  const actor = await platformAdmin(c, action, {});
  const userId = c.req.param('userId') ?? '';
  const user = id.safeParse(userId).success ? await getUserSummary(c.env.DB, userId) : null;
  if (!user) throw new ApiError(404, 'user_not_found', { userId });
  return { actor, user };
}

const roomStub = (env: Env, roomId: string) => env.ROOM.get(env.ROOM.idFromName(roomId));
const hubStub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));

/** The account's live streams across its rooms (metadata only). */
async function liveStreams(env: Env, userId: string, now: number) {
  const rooms = await roomsOfUser(env.DB, userId, now);
  const perRoom = await Promise.all(
    rooms.map(async (room) => {
      const streams: UserStreamInfo[] = await roomStub(env, room.id).streamsOf(userId);
      return streams.map((s) => ({
        ...s,
        roomId: room.id,
        roomName: room.name,
        spaceId: room.spaceId,
        spaceName: room.spaceName,
      }));
    }),
  );
  return perRoom.flat();
}

async function detail(env: Env, userId: string) {
  const now = Date.now();
  const db = env.DB;
  const [user, sessions, devices, audit, streams] = await Promise.all([
    getUserSummary(db, userId),
    activeSessions(db, userId, now),
    listDevices(db, userId),
    recentAudit(db, userId),
    liveStreams(env, userId, now),
  ]);
  if (!user) throw new ApiError(404, 'user_not_found', { userId });
  return { ...user, sessions, devices, audit, streams };
}

/**
 * GET /api/admin/users/:userId: the summary plus active sessions (no IP), devices, the recent
 * audit entries by or about the account, and its live streams (metadata only).
 */
adminUsers.get('/admin/users/:userId', async (c) => {
  const { user } = await target(c, 'platform.user.view');
  return c.json({ user: await detail(c.env, user.id) });
});

/**
 * Cuts every live connection of the account, with the rooms computed before D1
 * changed: its devices' room sockets are revoked (pending publications closed), every room
 * socket gets `kicked { reason }` and close 4004 (streams end, slots and queue places go), and
 * every hub socket gets error session_expired and close 4001.
 */
async function cutOff(
  env: Env,
  userId: string,
  rooms: string[],
  deviceIds: string[],
  reason: KickReason,
) {
  const hub = hubStub(env, userId);
  const deviceRooms = await Promise.all(
    deviceIds.map(async (deviceId) => ({ deviceId, rooms: await hub.takeDeviceRooms(deviceId) })),
  );
  const all = new Set([...rooms, ...deviceRooms.flatMap((d) => d.rooms)]);
  await Promise.all([...all].map((roomId) => roomStub(env, roomId).kick(userId, reason)));
  await Promise.all(
    deviceRooms.flatMap((d) =>
      d.rooms.map((roomId) => roomStub(env, roomId).revokeDevice(d.deviceId)),
    ),
  );
  await hub.revokeAll();
}

async function liveDeviceIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL')
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Nobody bans or deletes themselves, and the instance always keeps a platform admin. */
async function guard(
  db: D1Database,
  actorId: string,
  user: { id: string; isPlatformAdmin: boolean },
) {
  if (user.id === actorId) throw new ApiError(409, 'cannot_target_self', { userId: user.id });
  if (user.isPlatformAdmin && (await otherAdmins(db, user.id)) === 0) {
    throw new ApiError(409, 'last_platform_admin', { userId: user.id });
  }
}

const banInput = z.strictObject({ reason: z.string().trim().max(500).optional() });

/**
 * POST /api/admin/users/:userId/ban { reason? }: a platform ban (audited). The account cannot sign
 * in, its sessions and devices are revoked, its identities are recorded so they cannot sign up
 * again, and its sockets close at once (its streams end). Banning a banned account changes nothing.
 */
adminUsers.post('/admin/users/:userId/ban', async (c) => {
  const { actor, user } = await target(c, 'platform.user.ban');
  const input = await body(c, banInput);
  if (user.bannedAt !== null) return c.json({ user: await detail(c.env, user.id) });
  await guard(c.env.DB, actor.id, user);
  const db = c.env.DB;
  const now = Date.now();
  const [rooms, devices] = await Promise.all([
    roomsOfUser(db, user.id, now),
    liveDeviceIds(db, user.id),
  ]);
  const reason = input.reason || null;
  const [banned] = await db.batch([
    db
      .prepare(
        `UPDATE users SET banned_at = ?, banned_reason = ?, banned_by = ?
         WHERE id = ? AND banned_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, reason, actor.id, user.id),
    ...(await banIdentityStatements(db, user.id, actor.id, now)),
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, user.id),
    db
      .prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, user.id),
    auditStatement(
      db,
      {
        spaceId: null,
        actorId: actor.id,
        action: 'platform.user.ban',
        target: user.id,
        data: reason ? { reason } : {},
      },
      now,
    ),
  ]);
  if (!banned?.meta.changes) throw new ApiError(404, 'user_not_found', { userId: user.id });
  await cutOff(
    c.env,
    user.id,
    rooms.map((r) => r.id),
    devices,
    KickReason.Banned,
  );
  return c.json({ user: await detail(c.env, user.id) });
});

/**
 * POST /api/admin/users/:userId/unban: lifts the ban (audited) and frees its identities. Sessions
 * and devices revoked by the ban stay revoked: the person signs in and pairs again.
 */
adminUsers.post('/admin/users/:userId/unban', async (c) => {
  const { actor, user } = await target(c, 'platform.user.ban');
  if (user.bannedAt === null) return c.json({ user: await detail(c.env, user.id) });
  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE users SET banned_at = NULL, banned_reason = NULL, banned_by = NULL WHERE id = ?`,
      )
      .bind(user.id),
    db.prepare('DELETE FROM banned_identities WHERE user_id = ?').bind(user.id),
    auditStatement(
      db,
      { spaceId: null, actorId: actor.id, action: 'platform.user.unban', target: user.id },
      now,
    ),
  ]);
  return c.json({ user: await detail(c.env, user.id) });
});

/**
 * POST /api/admin/users/:userId/sessions/revoke: signs every browser out (audited), without a
 * ban. Like a sign-out from Settings, sockets already open stay until they reconnect.
 */
adminUsers.post('/admin/users/:userId/sessions/revoke', async (c) => {
  const { actor, user } = await target(c, 'platform.user.ban');
  const db = c.env.DB;
  const now = Date.now();
  const [revoked] = await db.batch([
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(now, user.id),
  ]);
  const count = revoked?.meta.changes ?? 0;
  await auditStatement(
    db,
    {
      spaceId: null,
      actorId: actor.id,
      action: 'platform.user.sessions.revoke',
      target: user.id,
      data: { count },
    },
    now,
  ).run();
  return c.json({ revoked: count });
});

/**
 * POST /api/admin/users/:userId/devices/revoke: unpairs every helper (audited), without a ban:
 * their sockets get error session_expired and close with 4001, their streams end
 * (PROTOCOL.md 11.1).
 */
adminUsers.post('/admin/users/:userId/devices/revoke', async (c) => {
  const { actor, user } = await target(c, 'platform.user.ban');
  const db = c.env.DB;
  const now = Date.now();
  const deviceIds = await liveDeviceIds(db, user.id);
  const placeholders = deviceIds.map(() => '?').join(', ');
  if (deviceIds.length > 0) {
    await db
      .prepare(
        `UPDATE devices SET revoked_at = ? WHERE id IN (${placeholders}) AND revoked_at IS NULL`,
      )
      .bind(now, ...deviceIds)
      .run();
  }
  await auditStatement(
    db,
    {
      spaceId: null,
      actorId: actor.id,
      action: 'platform.user.devices.revoke',
      target: user.id,
      data: { count: deviceIds.length },
    },
    now,
  ).run();
  const hub = hubStub(c.env, user.id);
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const rooms = await hub.takeDeviceRooms(deviceId);
      await Promise.all([
        hub.revokeDevice(deviceId),
        ...rooms.map((roomId) => roomStub(c.env, roomId).revokeDevice(deviceId)),
      ]);
    }),
  );
  return c.json({ revoked: deviceIds.length });
});

const deleteInput = z.strictObject({
  ban: z.boolean().optional(),
  // What happens to the account's chat messages: deleted, or kept
  // as "account removed". Default: deleted.
  messages: z.enum(['delete', 'anonymize']).optional(),
});

/** The DELETE body is optional: none means `{}`. */
async function deleteBody(c: Ctx): Promise<z.output<typeof deleteInput>> {
  const length = c.req.header('Content-Length');
  const type = c.req.header('Content-Type') ?? '';
  if (!type.startsWith('application/json') || length === '0') return {};
  return body(c, deleteInput);
}

/**
 * DELETE /api/admin/users/:userId { ban?, messages? }: deletes the account and its personal data
 * (LGPD, audited). Refused with owner_must_transfer while it owns a space (delete or
 * transfer those first). Its sockets close at once. With `ban`, its identities stay banned; a ban
 * recorded before is never lifted by deleting. Its chat messages are deleted, or anonymized with
 * `messages: "anonymize"`, in every room it wrote in (docs/PROTOCOL.md 7.6).
 */
adminUsers.delete('/admin/users/:userId', async (c) => {
  const { actor, user } = await target(c, 'platform.user.delete');
  const input = await deleteBody(c);
  await guard(c.env.DB, actor.id, user);
  const db = c.env.DB;
  const owned = await ownedSpaces(db, user.id);
  if (owned.length > 0) {
    throw new ApiError(409, 'owner_must_transfer', { userId: user.id, spaceIds: owned });
  }
  const now = Date.now();
  const [rooms, devices, chatRooms] = await Promise.all([
    roomsOfUser(db, user.id, now),
    liveDeviceIds(db, user.id),
    chatRoomsOf(db, user.id),
  ]);
  const ban = input.ban === true;
  const messages = input.messages ?? 'delete';
  await db.batch([
    // Recorded before the identities go, so the ban covers them.
    ...(ban ? await banIdentityStatements(db, user.id, actor.id, now) : []),
    ...(ban
      ? [
          db
            .prepare('UPDATE users SET banned_at = coalesce(banned_at, ?) WHERE id = ?')
            .bind(now, user.id),
        ]
      : []),
    ...(await deletionStatements(db, user.id, now)),
    auditStatement(
      db,
      {
        spaceId: null,
        actorId: actor.id,
        action: 'platform.user.delete',
        target: user.id,
        data: { ban: ban || user.bannedAt !== null, messages },
      },
      now,
    ),
  ]);
  await cutOff(
    c.env,
    user.id,
    rooms.map((r) => r.id),
    devices,
    KickReason.Removed,
  );
  await Promise.all(
    chatRooms.map((roomId) => roomStub(c.env, roomId).eraseChatAuthor(user.id, messages)),
  );
  // The uploaded profile photo is personal data too (one R2 delete, a no-op when there is none).
  await c.env.THUMBNAILS.delete(avatarKey(user.id));
  return c.body(null, 204);
});
