// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { can } from '../auth/can';
import { auditStatement } from '../db/audit';
import {
  consumeInvite,
  getInvite,
  getInviteByHash,
  getPendingJoinRequest,
  insertInviteStatement,
  insertJoinRequestStatement,
  type Invite,
  listActiveInvites,
  revokeInviteStatement,
} from '../db/invites';
import { getAccess, getRoomForActor, roomRef, upsertAccessStatement } from '../db/rooms';
import {
  getMember,
  getSpace,
  insertMemberStatement,
  type Member,
  setRoleStatement,
} from '../db/spaces';
import type { User } from '../db/users';
import { newId, randomToken, sha256Hex } from '../db/util';
import { ApiError } from '../errors';
import {
  actorOf,
  allowed,
  type AppEnv,
  authorize,
  body,
  loadSpace,
  requireUser,
  spaceRef,
  throttleCreate,
} from './context';
import { id } from './schemas';
import { syncUser } from './sync';

export const invites = new Hono<AppEnv>();

const HOUR_MS = 3_600_000;
/** Invites last 7 days and work once unless set otherwise. */
const DEFAULT_EXPIRY_HOURS = 7 * 24;
const MAX_EXPIRY_HOURS = 30 * 24;

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

const createInvite = z
  .strictObject({
    roomId: id.nullable().default(null),
    role: z.enum(['member', 'guest']).default('guest'),
    canStream: z.boolean().default(false),
    requiresApproval: z.boolean().default(false),
    maxUses: z.int().min(1).max(1000).default(1),
    expiresInHours: z.int().min(1).max(MAX_EXPIRY_HOURS).default(DEFAULT_EXPIRY_HOURS),
  })
  // A room invite makes a guest of that room only (6.4.7).
  .refine((i) => i.roomId === null || i.role === 'guest', { path: ['role'] })
  // The stream permission is per room (6.4.5); members of the space stream anyway.
  .refine((i) => !i.canStream || i.roomId !== null, { path: ['canStream'] });

/**
 * POST /api/spaces/:id/invites: a space or room invite. The token is in this response only; D1
 * keeps its SHA-256.
 */
invites.post('/spaces/:spaceId/invites', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  const input = await body(c, createInvite);
  let room = null;
  if (input.roomId !== null) {
    room = await getRoomForActor(c.env.DB, input.roomId, user.id);
    if (!room || room.spaceId !== space.id) {
      // Decide the caller's right to invite at all before saying whether the room exists.
      authorize(
        actor,
        'invite.create',
        { space: spaceRef(space), role: input.role, canStream: false, room: null },
        { spaceId: space.id },
      );
      throw new ApiError(404, 'room_not_found', { roomId: input.roomId });
    }
  }
  authorize(
    actor,
    'invite.create',
    {
      space: spaceRef(space),
      role: input.role,
      canStream: input.canStream,
      room: room ? roomRef(room) : null,
    },
    room ? { spaceId: space.id, roomId: room.id } : { spaceId: space.id },
  );
  await throttleCreate(c, 'invite', user.id);
  const now = Date.now();
  const token = randomToken();
  const invite: Invite = {
    id: newId('in'),
    spaceId: space.id,
    roomId: input.roomId,
    role: input.role,
    canStream: input.canStream,
    requiresApproval: input.requiresApproval,
    maxUses: input.maxUses,
    uses: 0,
    expiresAt: now + input.expiresInHours * HOUR_MS,
    createdBy: user.id,
    createdAt: now,
    revokedAt: null,
  };
  await c.env.DB.batch([
    insertInviteStatement(c.env.DB, invite, await sha256Hex(token)),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: 'invite.create',
        target: invite.id,
        data: {
          roomId: invite.roomId,
          role: invite.role,
          canStream: invite.canStream,
          requiresApproval: invite.requiresApproval,
          maxUses: invite.maxUses,
          expiresAt: invite.expiresAt,
        },
      },
      now,
    ),
  ]);
  return c.json({ invite, token }, 201);
});

/** GET /api/spaces/:id/invites: usable invites; owners and admins see all, members their own. */
invites.get('/spaces/:spaceId/invites', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  const ref = spaceRef(space);
  authorize(actor, 'invite.manage', { space: ref, createdBy: user.id }, { spaceId: space.id });
  const list = (await listActiveInvites(c.env.DB, space.id, Date.now())).filter((i) =>
    allowed(actor, 'invite.manage', { space: ref, createdBy: i.createdBy }),
  );
  return c.json({ invites: list });
});

/** DELETE /api/invites/:id: revoke. */
invites.delete('/invites/:inviteId', async (c) => {
  const user = await requireUser(c);
  const inviteId = c.req.param('inviteId');
  const invite = await getInvite(c.env.DB, inviteId);
  if (!invite) throw new ApiError(404, 'invite_not_found', { inviteId });
  const { space, actor } = await loadSpace(c, user, invite.spaceId);
  authorize(
    actor,
    'invite.manage',
    { space: spaceRef(space), createdBy: invite.createdBy },
    { spaceId: space.id },
  );
  if (invite.revokedAt === null) {
    const now = Date.now();
    await c.env.DB.batch([
      revokeInviteStatement(c.env.DB, space.id, invite.id, now),
      auditStatement(
        c.env.DB,
        { spaceId: space.id, actorId: user.id, action: 'invite.revoke', target: invite.id },
        now,
      ),
    ]);
  }
  return c.body(null, 204);
});

/**
 * The statements that give `user` what `invite` grants, given their current membership: a new
 * membership, a role raised to the invite's, or a room grant. Empty when it gives nothing new.
 * Shared by accepting an invite and approving a join request.
 */
export async function grantStatements(
  db: D1Database,
  invite: Pick<Invite, 'id' | 'spaceId' | 'roomId' | 'role' | 'canStream' | 'createdBy'>,
  user: User,
  member: Member | null,
  now: number,
): Promise<{ statements: D1PreparedStatement[]; roleChanged: boolean }> {
  if (invite.roomId === null) {
    if (!member) {
      return {
        statements: [
          insertMemberStatement(db, invite.spaceId, user.id, invite.role, invite.createdBy, now),
        ],
        roleChanged: true,
      };
    }
    if (RANK[member.role] < RANK[invite.role]) {
      return {
        statements: [setRoleStatement(db, invite.spaceId, user.id, invite.role)],
        roleChanged: true,
      };
    }
    return { statements: [], roleChanged: false };
  }
  const existing = await getAccess(db, invite.spaceId, invite.roomId, user.id);
  const canStream = invite.canStream || (existing?.canStream ?? false);
  if (existing?.canView && existing.canStream === canStream && existing.expiresAt === null) {
    return { statements: [], roleChanged: false };
  }
  return {
    statements: [
      upsertAccessStatement(db, invite.spaceId, invite.roomId, {
        userId: user.id,
        canView: true,
        canStream,
        // The inviter is the guest's grantor, so they can manage the guest (matrix 6.4.4).
        grantedBy: existing?.grantedBy ?? invite.createdBy,
        grantedAt: now,
        expiresAt: null,
      }),
    ],
    roleChanged: false,
  };
}

/** Whether the invite would give `user` anything they do not have yet. */
async function wouldGrant(
  db: D1Database,
  invite: Invite,
  user: User,
  member: Member | null,
  now: number,
): Promise<boolean> {
  if (invite.roomId === null) return !member || RANK[member.role] < RANK[invite.role];
  const room = await getRoomForActor(db, invite.roomId, user.id);
  if (!room) throw new ApiError(404, 'invite_not_found');
  const actor = actorOf(user, member, invite.spaceId);
  const view = can(actor, 'room.view', { room: roomRef(room) }, now);
  if (!view.allowed && view.code === 'room_closed') {
    throw new ApiError(410, 'room_closed', { roomId: room.id });
  }
  return (
    !view.allowed ||
    (invite.canStream && !can(actor, 'stream.permission', { room: roomRef(room) }, now).allowed)
  );
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET /api/invites/:token: what the invite gives, for the web's accept page (the space and room
 * names, role, approval). Same refusals as accepting, so it reveals nothing accept would not.
 */
invites.get('/invites/:token', async (c) => {
  const user = await requireUser(c);
  const token = c.req.param('token');
  const invite = TOKEN_PATTERN.test(token)
    ? await getInviteByHash(c.env.DB, await sha256Hex(token))
    : null;
  const space = invite ? await getSpace(c.env.DB, invite.spaceId) : null;
  if (!invite || !space) throw new ApiError(404, 'invite_not_found');
  const pending = invite.requiresApproval
    ? (await getPendingJoinRequest(c.env.DB, invite.spaceId, user.id, invite.roomId)) !== null
    : false;
  const now = Date.now();
  if (!pending) {
    if (invite.revokedAt !== null) throw new ApiError(410, 'invite_revoked');
    if (invite.expiresAt <= now) throw new ApiError(410, 'invite_expired');
    if (invite.uses >= invite.maxUses) throw new ApiError(410, 'invite_exhausted');
  }
  const room = invite.roomId ? await getRoomForActor(c.env.DB, invite.roomId, user.id) : null;
  return c.json({
    invite: {
      spaceName: space.name,
      roomName: room?.name ?? null,
      role: invite.role,
      canStream: invite.canStream,
      requiresApproval: invite.requiresApproval,
      expiresAt: invite.expiresAt,
    },
    pending,
  });
});

/**
 * POST /api/invites/:token/accept. Gives the membership or room grant at once, or files a
 * join_request when the invite needs approval (202). Each acceptance takes one use.
 */
invites.post('/invites/:token/accept', async (c) => {
  const user = await requireUser(c);
  const token = c.req.param('token');
  const invite = TOKEN_PATTERN.test(token)
    ? await getInviteByHash(c.env.DB, await sha256Hex(token))
    : null;
  if (!invite) throw new ApiError(404, 'invite_not_found');
  const now = Date.now();
  // Asking again while a request is pending answers with it, even once the invite is used up.
  if (invite.requiresApproval) {
    const pending = await getPendingJoinRequest(c.env.DB, invite.spaceId, user.id, invite.roomId);
    if (pending) return c.json({ status: 'pending', joinRequest: pending }, 202);
  }
  if (invite.revokedAt !== null) throw new ApiError(410, 'invite_revoked');
  if (invite.expiresAt <= now) throw new ApiError(410, 'invite_expired');
  if (invite.uses >= invite.maxUses) throw new ApiError(410, 'invite_exhausted');

  const member = await getMember(c.env.DB, invite.spaceId, user.id);
  if (member?.bannedAt != null) throw new ApiError(403, 'banned', { spaceId: invite.spaceId });
  if (!(await wouldGrant(c.env.DB, invite, user, member, now))) {
    throw new ApiError(409, 'already_member');
  }
  await throttleCreate(c, 'inviteAccept', user.id);

  if (!(await consumeInvite(c.env.DB, invite.spaceId, invite.id, now))) {
    throw new ApiError(410, 'invite_exhausted');
  }

  if (invite.requiresApproval) {
    const requestId = newId('jr');
    await c.env.DB.batch([
      insertJoinRequestStatement(
        c.env.DB,
        {
          id: requestId,
          spaceId: invite.spaceId,
          roomId: invite.roomId,
          userId: user.id,
          inviteId: invite.id,
        },
        now,
      ),
      auditStatement(
        c.env.DB,
        {
          spaceId: invite.spaceId,
          actorId: user.id,
          action: 'join_request.create',
          target: requestId,
          data: { inviteId: invite.id },
        },
        now,
      ),
    ]);
    const joinRequest = await getPendingJoinRequest(
      c.env.DB,
      invite.spaceId,
      user.id,
      invite.roomId,
    );
    return c.json({ status: 'pending', joinRequest }, 202);
  }

  const { statements, roleChanged } = await grantStatements(c.env.DB, invite, user, member, now);
  await c.env.DB.batch([
    ...statements,
    auditStatement(
      c.env.DB,
      {
        spaceId: invite.spaceId,
        actorId: user.id,
        action: 'invite.accept',
        target: invite.id,
        data: { roomId: invite.roomId, role: invite.role, canStream: invite.canStream },
      },
      now,
    ),
  ]);
  if (roleChanged && member) await syncUser(c.env, invite.spaceId, user.id, 'role_changed');
  if (invite.roomId !== null) {
    await syncUser(c.env, invite.spaceId, user.id, 'access_revoked', [invite.roomId]);
  }
  return c.json(
    { status: 'joined', spaceId: invite.spaceId, roomId: invite.roomId, role: invite.role },
    200,
  );
});
