// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import type { z } from 'zod';
import {
  type Action,
  type Actor,
  can,
  type ResourceByAction,
  type SpaceRef,
  type Target,
} from '../auth/can';
import { clearLegacySessionCookie, setSessionCookie } from '../auth/cookies';
import { appOrigin } from '../auth/origin';
import { consume, type CreateKind, createLimit } from '../auth/rate-limit';
import { SESSION_TTL_MS } from '../auth/session';
import { getRoomForActor, type RoomForActor } from '../db/rooms';
import { getMember, getSpace, type Member, type Space } from '../db/spaces';
import { getUser, type User } from '../db/users';
import { noteSpace } from '../metrics/errors';
import { ApiError } from '../errors';
import { resolveIdentity } from '../room/identity';

// Request plumbing shared by the REST routes: who is calling, body validation, and loading what
// can() needs. Every authorization decision goes through can().

export type AppEnv = { Bindings: Env };
export type Ctx = Context<AppEnv>;

/**
 * The caller and their session id (null for the development identity, devices and the app),
 * device id (helpers) or app token id (the mobile app), or 401. Uses the same resolver as the
 * room socket. A session due for renewal is rotated here, and the new cookie set.
 *
 * A device token only works where the route says `allowDevice`: the routes the helper calls (the
 * room's settings and the SFU proxy). Anywhere else it gets 403, so a helper token taken from a
 * machine cannot act as its owner: no profile, sessions, invites, moderation or admin actions.
 *
 * An app token is its user on every route, with the same can() rules, but never with the
 * platform admin's powers: the instance's administration stays on the web, so a
 * phone's token cannot ban people, change platform settings or enter suspended spaces.
 */
export async function authenticate(
  c: Ctx,
  options: { allowDevice?: boolean } = {},
): Promise<{
  user: User;
  sessionId: string | null;
  deviceId: string | null;
  appTokenId: string | null;
}> {
  const origin = appOrigin(c.req.raw, c.env);
  // Renew only where the new cookie can be set; otherwise the old token keeps working as is.
  const identity = await resolveIdentity(c.req.raw, c.env, { renew: origin !== null });
  const user = identity ? await getUser(c.env.DB, identity.userId) : null;
  if (!identity || !user) throw new ApiError(401, 'unauthenticated');
  if (identity.deviceId && !options.allowDevice) throw new ApiError(403, 'forbidden');
  if (identity.rotatedToken && origin) {
    setSessionCookie(c, origin, identity.rotatedToken, SESSION_TTL_MS);
    // Signed in before the __Host- prefix: the old cookie goes once the new one is set.
    if (identity.legacyCookie) clearLegacySessionCookie(c, origin);
  }
  const appTokenId = identity.appTokenId ?? null;
  return {
    user: appTokenId ? { ...user, isPlatformAdmin: false } : user,
    sessionId: identity.sessionId ?? null,
    deviceId: identity.deviceId ?? null,
    appTokenId,
  };
}

/** Counts one creation against the caller's hourly limit (rate-limit.ts), or 429. */
export async function throttleCreate(c: Ctx, kind: CreateKind, userId: string): Promise<void> {
  const wait = await consume(c.env.DB, [createLimit(kind, userId)], Date.now());
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
}

/** The caller, or 401. */
export async function requireUser(c: Ctx): Promise<User> {
  return (await authenticate(c)).user;
}

/** The JSON body parsed by `schema`, or 400 invalid_message with a JSON Pointer to the field. */
export async function body<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_message', { path: '' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    throw new ApiError(400, 'invalid_message', {
      path: path.map((p) => `/${String(p)}`).join(''),
    });
  }
  return parsed.data;
}

export function actorOf(user: User, member: Member | null, spaceId: string): Actor {
  return {
    userId: user.id,
    isPlatformAdmin: user.isPlatformAdmin,
    membership: member ? { spaceId, role: member.role, bannedAt: member.bannedAt } : null,
  };
}

export const spaceRef = (space: Space): SpaceRef => ({
  id: space.id,
  // Matrix 6.4.4: members invite guests unless the space turned it off.
  settings: { membersCanInviteGuests: space.settings['membersCanInviteGuests'] !== false },
});

export interface SpaceScope {
  user: User;
  space: Space;
  /** The caller's own space_members row, if any. */
  member: Member | null;
  actor: Actor;
}

export async function loadSpace(c: Ctx, user: User, spaceId: string): Promise<SpaceScope> {
  const space = await getSpace(c.env.DB, spaceId);
  if (!space) throw new ApiError(404, 'space_not_found', { spaceId });
  // A suspended space is closed to everyone but the platform admin who can lift it.
  if (space.suspendedAt !== null && !user.isPlatformAdmin) {
    throw new ApiError(403, 'space_suspended', { spaceId });
  }
  noteSpace(c.req.raw, space.id);
  const member = await getMember(c.env.DB, spaceId, user.id);
  return { user, space, member, actor: actorOf(user, member, spaceId) };
}

export interface RoomScope extends SpaceScope {
  room: RoomForActor;
}

export async function loadRoom(c: Ctx, user: User, roomId: string): Promise<RoomScope> {
  const room = await getRoomForActor(c.env.DB, roomId, user.id);
  if (!room) throw new ApiError(404, 'room_not_found', { roomId });
  return { ...(await loadSpace(c, user, room.spaceId)), room };
}

/**
 * Asks can() and turns a refusal into the error response. An outsider asking about a space gets
 * 404, so space ids cannot be probed; inside a room the answer matches the room socket (403).
 */
export function authorize<A extends Action>(
  actor: Actor,
  action: A,
  resource: ResourceByAction[A],
  ids: { spaceId: string; roomId?: string },
): void {
  const decision = can(actor, action, resource);
  if (decision.allowed) return;
  const { spaceId, roomId } = ids;
  switch (decision.code) {
    case 'not_space_member':
      if (roomId) throw new ApiError(403, 'forbidden', { roomId });
      throw new ApiError(404, 'space_not_found', { spaceId });
    case 'banned':
      throw new ApiError(403, 'banned', { spaceId });
    case 'room_closed':
      throw new ApiError(410, 'room_closed', { roomId });
    default:
      throw new ApiError(403, 'forbidden', roomId ? { roomId } : { spaceId });
  }
}

/**
 * A member as a can() Target. For someone who is not (or no longer) a member, a stand-in member:
 * the caller's own permission is then checked before the route reveals that the person is absent.
 */
export const targetOf = (userId: string, member: Member | null): Target =>
  member
    ? { userId, role: member.role, invitedBy: member.invitedBy }
    : { userId, role: 'member', invitedBy: null };

/** Whether can() allows it, for filtering lists. */
export const allowed = <A extends Action>(
  actor: Actor,
  action: A,
  resource: ResourceByAction[A],
): boolean => can(actor, action, resource).allowed;

function roomManage(scope: RoomScope) {
  const { space, room } = scope;
  return room.kind === 'fixed'
    ? ({ action: 'room.fixed.manage', resource: { space: spaceRef(space) } } as const)
    : ({
        action: 'room.quick.manage',
        resource: { space: spaceRef(space), createdBy: room.createdBy },
      } as const);
}

/** Fixed rooms are managed by owners and admins; quick rooms also by their creator. */
export function authorizeRoomManage(scope: RoomScope): void {
  const m = roomManage(scope);
  const ids = { spaceId: scope.space.id, roomId: scope.room.id };
  if (m.action === 'room.fixed.manage') authorize(scope.actor, m.action, m.resource, ids);
  else authorize(scope.actor, m.action, m.resource, ids);
}

export function canManageRoom(scope: RoomScope): boolean {
  const m = roomManage(scope);
  return m.action === 'room.fixed.manage'
    ? allowed(scope.actor, m.action, m.resource)
    : allowed(scope.actor, m.action, m.resource);
}

/** Archived or expired rooms cannot be changed. */
export function assertOpen(room: RoomForActor, now: number): void {
  if (room.archivedAt !== null || (room.expiresAt !== null && room.expiresAt <= now)) {
    throw new ApiError(410, 'room_closed', { roomId: room.id });
  }
}
