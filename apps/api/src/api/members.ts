// SPDX-License-Identifier: AGPL-3.0-only
import { KickReason } from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditStatement } from '../db/audit';
import { deleteAllAccessStatement } from '../db/rooms';
import {
  deleteMemberStatement,
  getMember,
  listMembers,
  type Member,
  setBannedStatement,
  setRoleStatement,
} from '../db/spaces';
import { ApiError } from '../errors';
import {
  type AppEnv,
  authorize,
  body,
  type Ctx,
  loadSpace,
  requireUser,
  type SpaceScope,
  spaceRef,
  targetOf,
} from './context';
import { syncUser } from './sync';

export const members = new Hono<AppEnv>();

/** GET /api/spaces/:id/members. Banned members are listed only to owners and admins. */
members.get('/spaces/:spaceId/members', async (c) => {
  const user = await requireUser(c);
  const { space, actor, member } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.view', { space: spaceRef(space) }, { spaceId: space.id });
  const manager = member?.role === 'owner' || member?.role === 'admin';
  return c.json({ members: await listMembers(c.env.DB, space.id, manager) });
});

/**
 * Loads the member a route acts on. The caller's permission for `check` is decided first (with a
 * stand-in target when the person is absent), so only someone allowed to act learns whether the
 * person is a member.
 */
async function targetMember(
  c: Ctx,
  scope: SpaceScope,
  check: (target: ReturnType<typeof targetOf>) => void,
): Promise<Member> {
  const userId = c.req.param('userId') ?? '';
  const target = await getMember(c.env.DB, scope.space.id, userId);
  check(targetOf(userId, target));
  if (!target) throw new ApiError(404, 'member_not_found', { userId });
  return target;
}

const changeRole = z.strictObject({ role: z.enum(['admin', 'member', 'guest']) });

/** PATCH /api/spaces/:id/members/:userId: change a role (ownership moves only by transfer). */
members.patch('/spaces/:spaceId/members/:userId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadSpace(c, user, c.req.param('spaceId'));
  const { space, actor } = scope;
  const { role } = await body(c, changeRole);
  const target = await targetMember(c, scope, (t) =>
    authorize(
      actor,
      'member.role.change',
      { space: spaceRef(space), target: t, newRole: role },
      { spaceId: space.id },
    ),
  );
  if (target.role !== role) {
    const now = Date.now();
    await c.env.DB.batch([
      setRoleStatement(c.env.DB, space.id, target.userId, role),
      auditStatement(
        c.env.DB,
        {
          spaceId: space.id,
          actorId: user.id,
          action: 'member.role.change',
          target: target.userId,
          data: { from: target.role, to: role },
        },
        now,
      ),
    ]);
    // A demotion that loses a restricted room kicks from it; elsewhere permissions.changed.
    await syncUser(c.env, space.id, target.userId, KickReason.RoleChanged);
  }
  return c.json({ member: { ...target, role } });
});

async function setBan(c: Ctx, banned: boolean): Promise<Response> {
  const user = await requireUser(c);
  const scope = await loadSpace(c, user, c.req.param('spaceId') ?? '');
  const { space, actor } = scope;
  const target = await targetMember(c, scope, (t) =>
    authorize(actor, 'member.ban', { space: spaceRef(space), target: t }, { spaceId: space.id }),
  );
  const now = Date.now();
  if ((target.bannedAt !== null) !== banned) {
    await c.env.DB.batch([
      setBannedStatement(c.env.DB, space.id, target.userId, banned ? now : null),
      auditStatement(
        c.env.DB,
        {
          spaceId: space.id,
          actorId: user.id,
          action: banned ? 'member.ban' : 'member.unban',
          target: target.userId,
        },
        now,
      ),
    ]);
    if (banned) await syncUser(c.env, space.id, target.userId, KickReason.Banned);
  }
  const bannedAt = banned ? (target.bannedAt ?? now) : null;
  return c.json({ member: { ...target, bannedAt } });
}

/** POST /api/spaces/:id/members/:userId/ban: banned members keep their row and lose all access. */
members.post('/spaces/:spaceId/members/:userId/ban', (c) => setBan(c, true));
members.delete('/spaces/:spaceId/members/:userId/ban', (c) => setBan(c, false));

/**
 * DELETE /api/spaces/:id/members/:userId: leave (yourself) or remove someone (same rule as a ban).
 * Room grants in the space go too. Grants the person gave others stay.
 */
members.delete('/spaces/:spaceId/members/:userId', async (c) => {
  const user = await requireUser(c);
  const scope = await loadSpace(c, user, c.req.param('spaceId'));
  const { space, actor } = scope;
  const self = c.req.param('userId') === user.id;
  const target = await targetMember(c, scope, (t) => {
    if (!self) {
      authorize(actor, 'member.ban', { space: spaceRef(space), target: t }, { spaceId: space.id });
    }
  });
  if (self && target.role === 'owner') {
    throw new ApiError(409, 'owner_must_transfer', { spaceId: space.id });
  }
  // Leaving would drop the ban with the row, and an invite would let the person back in.
  if (self && target.bannedAt !== null) throw new ApiError(403, 'banned', { spaceId: space.id });
  const now = Date.now();
  await c.env.DB.batch([
    deleteMemberStatement(c.env.DB, space.id, target.userId),
    deleteAllAccessStatement(c.env.DB, space.id, target.userId),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: self ? 'member.leave' : 'member.remove',
        target: target.userId,
        data: { role: target.role },
      },
      now,
    ),
  ]);
  await syncUser(c.env, space.id, target.userId, KickReason.Removed);
  return c.body(null, 204);
});
