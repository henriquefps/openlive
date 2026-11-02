// SPDX-License-Identifier: AGPL-3.0-only
import { KickReason } from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { can } from '../auth/can';
import { consume, type Limit } from '../auth/rate-limit';
import { ipHash } from '../auth/session';
import { auditStatement } from '../db/audit';
import { platformRoomLimits } from '../db/platform';
import {
  type Access,
  archiveRoomStatement,
  deleteAccessStatement,
  getAccess,
  getRoomByCode,
  insertRoomStatement,
  roomCapabilities,
  listAccess,
  listRoomsForActor,
  type Room,
  type RoomForActor,
  roomRef,
  updateRoomStatement,
  upsertAccessStatement,
} from '../db/rooms';
import { getMember, listMembers, type Space } from '../db/spaces';
import { getUser } from '../db/users';
import { isUniqueViolation, newId } from '../db/util';
import { ApiError } from '../errors';
import {
  allowed,
  type AppEnv,
  assertOpen,
  authenticate,
  authorize,
  authorizeRoomManage,
  body,
  canManageRoom,
  type Ctx,
  loadRoom,
  loadSpace,
  requireUser,
  spaceRef,
  throttleCreate,
} from './context';
import {
  applyPatch,
  checkCapabilities,
  checkLimits,
  newRoomCapabilities,
  quickRoomHours,
  roomLimits,
  roomSettingsPatch,
  spaceLimits,
} from './settings';
import { id, name, slug } from './schemas';
import { capabilitiesSchema, QUICK_ROOM_DEFAULT, WATCH_TOGETHER } from '../room/capabilities';
import { closeRooms, setRoomExpiry, syncRoomSettings, syncRoomVisibility, syncUser } from './sync';

export const rooms = new Hono<AppEnv>();

const HOUR_MS = 3_600_000;

async function roomJson(c: Ctx, space: Space, room: Room | RoomForActor) {
  const fields: Partial<RoomForActor> = { ...room };
  delete fields.actorAccess;
  return {
    ...fields,
    effectiveSettings: roomLimits(
      space.settings,
      room.settings,
      await platformRoomLimits(c.env.DB),
    ),
  };
}

/** GET /api/spaces/:id/rooms: the open rooms the caller may see (restricted ones filtered). */
rooms.get('/spaces/:spaceId/rooms', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.view', { space: spaceRef(space) }, { spaceId: space.id });
  const list = (await listRoomsForActor(c.env.DB, space.id, user.id)).filter((room) =>
    allowed(actor, 'room.view', { room: roomRef(room) }),
  );
  return c.json({ rooms: await Promise.all(list.map((room) => roomJson(c, space, room))) });
});

const createFixed = z.strictObject({
  name,
  slug,
  visibility: z.enum(['space', 'restricted']).default('space'),
  settings: roomSettingsPatch.default({}),
});

/** POST /api/spaces/:id/rooms: a fixed room (owners and admins). */
rooms.post('/spaces/:spaceId/rooms', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'room.fixed.manage', { space: spaceRef(space) }, { spaceId: space.id });
  const input = await body(c, createFixed);
  const ceiling = spaceLimits(space.settings, await platformRoomLimits(c.env.DB));
  checkCapabilities(input.settings.capabilities, ceiling.capabilities, '/settings');
  const settings = applyPatch({}, input.settings);
  checkLimits(settings, ceiling, '/settings');
  await throttleCreate(c, 'room', user.id);
  // Without a choice, "Watch together", within what the space allows.
  settings['capabilities'] = newRoomCapabilities(
    input.settings.capabilities,
    WATCH_TOGETHER,
    ceiling.capabilities,
  );
  const now = Date.now();
  const room: Omit<Room, 'lastActiveAt' | 'archivedAt'> = {
    id: newId('rm'),
    spaceId: space.id,
    kind: 'fixed',
    name: input.name,
    slug: input.slug,
    code: null,
    visibility: input.visibility,
    settings,
    createdBy: user.id,
    createdAt: now,
    expiresAt: null,
  };
  try {
    await c.env.DB.batch([
      insertRoomStatement(c.env.DB, room),
      auditStatement(
        c.env.DB,
        {
          spaceId: space.id,
          actorId: user.id,
          action: 'room.create',
          target: room.id,
          data: { kind: 'fixed', capabilities: settings['capabilities'] },
        },
        now,
      ),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'slug_taken', { slug: input.slug });
    throw err;
  }
  return c.json(
    { room: await roomJson(c, space, { ...room, lastActiveAt: null, archivedAt: null }) },
    201,
  );
});

const createQuick = z.strictObject({
  spaceId: id,
  name: name.optional(),
  capabilities: capabilitiesSchema.optional(),
});

// Quick room codes: OL- and eight digits in two groups, like OL-4821-0937. The code alone
// opens the room to anyone signed in, so it is drawn from 10^8 values rather than the 10^4
// of the original sketch: with the per-user and per-IP limits below, guessing one of the open rooms stays
// improbable even with many rooms open. Digits only, so a phone shows the numeric keypad and the
// code can be read aloud without spelling.
const CODE_DIGITS = 8;
const CODE_RANGE = 10 ** CODE_DIGITS;
// The largest multiple of CODE_RANGE below 2^32: values above it are redrawn, so every code is
// equally likely.
const CODE_DRAW_LIMIT = Math.floor(2 ** 32 / CODE_RANGE) * CODE_RANGE;

const formatCode = (digits: string): string => `OL-${digits.slice(0, 4)}-${digits.slice(4)}`;

/** A fresh random code in canonical form; the room's slug is its lowercase form. */
function quickCode(): string {
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    if (value < CODE_DRAW_LIMIT) {
      return formatCode(String(value % CODE_RANGE).padStart(CODE_DIGITS, '0'));
    }
  }
}

/**
 * The canonical form of a code as people type it: any case, with or without the OL prefix, with
 * spaces or hyphens anywhere (`OL-4821-0937`, `ol48210937`, `4821 0937`). Null when it cannot be a
 * code.
 */
export function parseRoomCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  const digits = new RegExp(`^(?:OL)?(\\d{${CODE_DIGITS}})$`).exec(compact)?.[1];
  return digits ? formatCode(digits) : null;
}

/**
 * POST /api/rooms/quick: any member (not guests) opens a quick room. It closes on its own after the
 * space's quickRoomHours (default 12); the RoomDO's alarm enforces it.
 */
rooms.post('/rooms/quick', async (c) => {
  const user = await requireUser(c);
  const input = await body(c, createQuick);
  const { space, actor } = await loadSpace(c, user, input.spaceId);
  authorize(actor, 'room.quick.create', { space: spaceRef(space) }, { spaceId: space.id });
  const ceiling = spaceLimits(space.settings, await platformRoomLimits(c.env.DB)).capabilities;
  checkCapabilities(input.capabilities, ceiling, '');
  // Quick rooms are short meetings: stream and voice unless asked otherwise.
  const capabilities = newRoomCapabilities(input.capabilities, QUICK_ROOM_DEFAULT, ceiling);
  await throttleCreate(c, 'room', user.id);
  const now = Date.now();
  const expiresAt = now + quickRoomHours(space.settings) * HOUR_MS;
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = quickCode();
    const room: Omit<Room, 'lastActiveAt' | 'archivedAt'> = {
      id: newId('rm'),
      spaceId: space.id,
      kind: 'quick',
      name: input.name ?? code,
      slug: code.toLowerCase(),
      code,
      visibility: 'space',
      settings: { capabilities },
      createdBy: user.id,
      createdAt: now,
      expiresAt,
    };
    try {
      await c.env.DB.batch([
        insertRoomStatement(c.env.DB, room),
        auditStatement(
          c.env.DB,
          {
            spaceId: space.id,
            actorId: user.id,
            action: 'room.create',
            target: room.id,
            data: { kind: 'quick', expiresAt, capabilities },
          },
          now,
        ),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
    await setRoomExpiry(c.env, room.id, expiresAt);
    const json = await roomJson(c, space, { ...room, lastActiveAt: null, archivedAt: null });
    return c.json({ room: json, code }, 201);
  }
  throw new ApiError(500, 'internal_error');
});

// Joining by code is how a code would be guessed, so attempts are limited per user and per IP
// (keyed by the IP's HMAC). Every attempt counts, including the ones that succeed.
const JOIN_PER_USER: Omit<Limit, 'bucket'> = { max: 10, windowMs: 15 * 60 * 1000 };
const JOIN_PER_IP: Omit<Limit, 'bucket'> = { max: 30, windowMs: 60 * 60 * 1000 };

const joinByCode = z.strictObject({ code: z.string().max(64) });

/**
 * POST /api/rooms/join { code }: enters a quick room by its code. Members of the
 * room's space enter with their own role; anyone else signed in becomes a guest of that room only,
 * through a room_access grant that ends when the room expires. A restricted room still needs a
 * grant: the code does not override what its managers chose.
 */
rooms.post('/rooms/join', async (c) => {
  const user = await requireUser(c);
  const input = await body(c, joinByCode);
  const code = parseRoomCode(input.code);
  if (!code) throw new ApiError(400, 'room_code_invalid');

  const db = c.env.DB;
  const now = Date.now();
  const ip = await ipHash(c.req.raw, c.env);
  const limits: Limit[] = [
    { bucket: `room-code:user:${user.id}`, ...JOIN_PER_USER },
    ...(ip ? [{ bucket: `room-code:ip:${ip}`, ...JOIN_PER_IP }] : []),
  ];
  const wait = await consume(db, limits, now);
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });

  const found = await getRoomByCode(db, code, user.id);
  if (!found) throw new ApiError(404, 'room_code_invalid');
  assertOpen(found, now);
  const { space, member, actor } = await loadSpace(c, user, found.spaceId);
  const ids = { spaceId: space.id, roomId: found.id };

  let room = found;
  const view = can(actor, 'room.view', { room: roomRef(room) }, now);
  let granted = false;
  if (!view.allowed) {
    // Only someone outside the space gets in through the code; a banned member or a member of a
    // restricted room is refused as the room would refuse them.
    if (view.code !== 'not_space_member' || room.visibility === 'restricted') {
      authorize(actor, 'room.view', { room: roomRef(room) }, ids);
    }
    const existing = await getAccess(db, space.id, room.id, user.id);
    // A manager who set canView: false for this person keeps them out (until it expires).
    if (existing && !existing.canView && (existing.expiresAt ?? Infinity) > now) {
      throw new ApiError(403, 'forbidden', { roomId: room.id });
    }
    const access: Access = {
      userId: user.id,
      canView: true,
      canStream: existing?.canStream ?? false,
      // The room's creator shared the code, so they manage the guest like an inviter (6.4.4).
      grantedBy: existing?.grantedBy ?? room.createdBy,
      grantedAt: now,
      expiresAt: room.expiresAt,
    };
    await db.batch([
      upsertAccessStatement(db, space.id, room.id, access),
      auditStatement(
        db,
        {
          spaceId: space.id,
          actorId: user.id,
          action: 'room.join_code',
          target: room.id,
          data: { granted: true, expiresAt: access.expiresAt },
        },
        now,
      ),
    ]);
    room = { ...room, actorAccess: access };
    granted = true;
    await syncUser(c.env, space.id, user.id, KickReason.AccessRevoked, [room.id]);
  } else {
    await auditStatement(
      db,
      {
        spaceId: space.id,
        actorId: user.id,
        action: 'room.join_code',
        target: room.id,
        data: { granted: false },
      },
      now,
    ).run();
  }
  return c.json({
    room: await roomJson(c, space, room),
    // A guest of this room only never learns the space's slug; they use /rooms/:id.
    spaceSlug: member ? space.slug : null,
    role: member?.role ?? 'guest',
    granted,
  });
});

/** GET /api/rooms/:id: the room and its effective limits; the helper reads them too. */
rooms.get('/rooms/:roomId', async (c) => {
  const { user } = await authenticate(c, { allowDevice: true });
  const { space, actor, room } = await loadRoom(c, user, c.req.param('roomId'));
  authorize(actor, 'room.view', { room: roomRef(room) }, { spaceId: space.id, roomId: room.id });
  return c.json({ room: await roomJson(c, space, room) });
});

const updateRoom = z.strictObject({
  name: name.optional(),
  slug: slug.optional(),
  visibility: z.enum(['space', 'restricted']).optional(),
  settings: roomSettingsPatch.optional(),
});

/** PATCH /api/rooms/:id: name, slug, visibility and limits (within the space's). */
rooms.patch('/rooms/:roomId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadRoom(c, user, c.req.param('roomId'));
  const { space, room } = scope;
  authorizeRoomManage(scope);
  const now = Date.now();
  assertOpen(room, now);
  const input = await body(c, updateRoom);
  if (input.settings?.capabilities !== undefined) {
    // Capabilities are the space managers' choice, also in a quick room.
    authorize(
      scope.actor,
      'room.fixed.manage',
      { space: spaceRef(space) },
      { spaceId: space.id, roomId: room.id },
    );
  }
  const ceiling = spaceLimits(space.settings, await platformRoomLimits(c.env.DB));
  checkCapabilities(input.settings?.capabilities, ceiling.capabilities, '/settings');
  const settings = applyPatch(room.settings, input.settings ?? {});
  checkLimits(settings, ceiling, '/settings');
  const capabilitiesBefore = roomCapabilities(room.settings);
  const capabilitiesAfter = roomCapabilities(settings);
  const capabilitiesChanged =
    JSON.stringify(capabilitiesBefore) !== JSON.stringify(capabilitiesAfter);
  const fields = {
    name: input.name ?? room.name,
    slug: input.slug ?? room.slug,
    visibility: input.visibility ?? room.visibility,
    settings,
  };
  try {
    await c.env.DB.batch([
      updateRoomStatement(c.env.DB, space.id, room.id, fields),
      auditStatement(
        c.env.DB,
        {
          spaceId: space.id,
          actorId: user.id,
          action: 'room.update',
          target: room.id,
          data: input,
        },
        now,
      ),
      ...(capabilitiesChanged
        ? [
            auditStatement(
              c.env.DB,
              {
                spaceId: space.id,
                actorId: user.id,
                action: 'room.capabilities.update',
                target: room.id,
                data: { from: capabilitiesBefore, to: capabilitiesAfter },
              },
              now,
            ),
          ]
        : []),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'slug_taken', { slug: fields.slug });
    throw err;
  }
  // The space sidebar hides or shows the room's presence (PROTOCOL.md 7.8).
  if (fields.visibility !== room.visibility) {
    await syncRoomVisibility(c.env, room.id, fields.visibility);
  }
  if (room.visibility === 'space' && fields.visibility === 'restricted') {
    // Members and guests without a grant lose the room now (close 4003).
    const everyone = await listMembers(c.env.DB, space.id, false);
    await Promise.all(
      everyone
        .filter((m) => m.role === 'member' || m.role === 'guest')
        .map((m) => syncUser(c.env, space.id, m.userId, 'revoke', [room.id], now)),
    );
  }
  // New limits or capabilities reach the open room at once; turning stream off ends its streams.
  if (input.settings) await syncRoomSettings(c.env, [room.id]);
  return c.json({ room: await roomJson(c, space, { ...room, ...fields }) });
});

/** DELETE /api/rooms/:id: archive a fixed room or end a quick room early; everyone is closed out. */
rooms.delete('/rooms/:roomId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadRoom(c, user, c.req.param('roomId'));
  const { space, room } = scope;
  authorizeRoomManage(scope);
  const now = Date.now();
  assertOpen(room, now);
  await c.env.DB.batch([
    archiveRoomStatement(c.env.DB, space.id, room.id, now),
    auditStatement(
      c.env.DB,
      { spaceId: space.id, actorId: user.id, action: 'room.archive', target: room.id },
      now,
    ),
  ]);
  await closeRooms(c.env, [room.id], room.kind === 'fixed' ? 'archived' : 'ended_by_owner');
  return c.body(null, 204);
});

// --- room_access: per-room view and stream grants ---

rooms.get('/rooms/:roomId/access', async (c) => {
  const user = await requireUser(c);
  const scope = await loadRoom(c, user, c.req.param('roomId'));
  authorizeRoomManage(scope);
  return c.json({ access: await listAccess(c.env.DB, scope.space.id, scope.room.id) });
});

const putAccess = z
  .strictObject({
    canView: z.boolean().default(true),
    canStream: z.boolean().default(false),
    /** The grant ends at this time ("only today"); null or absent: until revoked. */
    expiresAt: z.int().min(0).nullable().default(null),
  })
  .refine((a) => a.canView || !a.canStream, { path: ['canStream'] });

/**
 * PUT /api/rooms/:id/access/:userId. Changing who sees the room is room management (owners and
 * admins, or a quick room's creator). Changing a guest's stream permission is guest.stream.set:
 * also the member who invited that guest, and never beyond the caller's own permission.
 */
rooms.put('/rooms/:roomId/access/:userId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadRoom(c, user, c.req.param('roomId'));
  const { space, actor, room } = scope;
  const now = Date.now();
  assertOpen(room, now);
  const input = await body(c, putAccess);
  const userId = c.req.param('userId');
  if (input.expiresAt !== null && input.expiresAt <= now) {
    throw new ApiError(400, 'invalid_message', { path: '/expiresAt' });
  }

  const ids = { spaceId: space.id, roomId: room.id };
  const [existing, member] = await Promise.all([
    getAccess(c.env.DB, space.id, room.id, userId),
    getMember(c.env.DB, space.id, userId),
  ]);
  const expiryChanged = (existing?.expiresAt ?? null) !== input.expiresAt;
  const viewChange = !existing || existing.canView !== input.canView;
  const streamChange =
    (existing?.canStream ?? false) !== input.canStream || (input.canStream && expiryChanged);
  const noChange = !viewChange && !streamChange && !expiryChanged;
  if (viewChange || (expiryChanged && !streamChange)) authorizeRoomManage(scope);
  // A no-op still needs one of the two permissions, so it reveals nothing to others.
  if (streamChange || (noChange && !canManageRoom(scope))) {
    authorize(
      actor,
      'guest.stream.set',
      {
        space: spaceRef(space),
        room: roomRef(room),
        // Someone with no membership is a guest of this room only; their inviter is the grantor.
        target: member
          ? { userId, role: member.role, invitedBy: member.invitedBy }
          : { userId, role: 'guest', invitedBy: existing?.grantedBy ?? null },
        grant: input.canStream,
      },
      ids,
    );
  }
  if (!existing && !(await getUser(c.env.DB, userId))) {
    throw new ApiError(404, 'user_not_found', { userId });
  }
  if (noChange) return c.json({ access: existing });

  const access: Access = {
    userId,
    ...input,
    // The original grantor keeps managing the guest they invited (matrix 6.4.4).
    grantedBy: existing?.grantedBy ?? user.id,
    grantedAt: now,
  };
  await c.env.DB.batch([
    upsertAccessStatement(c.env.DB, space.id, room.id, access),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: 'room_access.grant',
        target: userId,
        data: { roomId: room.id, ...input },
      },
      now,
    ),
  ]);
  await syncUser(c.env, space.id, userId, member ? 'revoke' : KickReason.AccessRevoked, [room.id]);
  return c.json({ access });
});

/** DELETE /api/rooms/:id/access/:userId: remove the grant (room management). */
rooms.delete('/rooms/:roomId/access/:userId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadRoom(c, user, c.req.param('roomId'));
  const { space, room } = scope;
  authorizeRoomManage(scope);
  const userId = c.req.param('userId');
  const existing = await getAccess(c.env.DB, space.id, room.id, userId);
  if (existing) {
    const now = Date.now();
    await c.env.DB.batch([
      deleteAccessStatement(c.env.DB, space.id, room.id, userId),
      auditStatement(
        c.env.DB,
        {
          spaceId: space.id,
          actorId: user.id,
          action: 'room_access.revoke',
          target: userId,
          data: { roomId: room.id, canView: existing.canView, canStream: existing.canStream },
        },
        now,
      ),
    ]);
    const member = await getMember(c.env.DB, space.id, userId);
    await syncUser(c.env, space.id, userId, member ? 'revoke' : KickReason.AccessRevoked, [
      room.id,
    ]);
  }
  return c.body(null, 204);
});
