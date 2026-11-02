// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { auditStatement } from '../db/audit';
import {
  decideJoinRequestStatement,
  getInvite,
  getJoinRequest,
  listJoinRequests,
} from '../db/invites';
import { getMember } from '../db/spaces';
import { getUser } from '../db/users';
import { ApiError } from '../errors';
import { type AppEnv, authorize, type Ctx, loadSpace, requireUser, spaceRef } from './context';
import { grantStatements } from './invites';
import { syncUser } from './sync';

export const joinRequests = new Hono<AppEnv>();

const statusQuery = z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']);

/** GET /api/spaces/:id/join-requests?status=pending (owners and admins). */
joinRequests.get('/spaces/:spaceId/join-requests', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'join_request.decide', { space: spaceRef(space) }, { spaceId: space.id });
  const status = statusQuery.safeParse(c.req.query('status') ?? 'pending');
  if (!status.success) throw new ApiError(400, 'invalid_message', { path: '/status' });
  return c.json({ joinRequests: await listJoinRequests(c.env.DB, space.id, status.data) });
});

async function decide(c: Ctx, status: 'approved' | 'rejected'): Promise<Response> {
  const user = await requireUser(c);
  const joinRequestId = c.req.param('joinRequestId') ?? '';
  const request = await getJoinRequest(c.env.DB, joinRequestId);
  if (!request) throw new ApiError(404, 'join_request_not_found', { joinRequestId });
  const { space, actor } = await loadSpace(c, user, request.spaceId);
  authorize(actor, 'join_request.decide', { space: spaceRef(space) }, { spaceId: space.id });
  if (request.status !== 'pending') {
    throw new ApiError(409, 'join_request_decided', { joinRequestId });
  }

  const now = Date.now();
  const statements = [
    decideJoinRequestStatement(c.env.DB, space.id, request.id, status, user.id, now),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: status === 'approved' ? 'join_request.approve' : 'join_request.reject',
        target: request.id,
        data: { userId: request.userId, roomId: request.roomId },
      },
      now,
    ),
  ];
  let roleChanged = false;
  let member = null;
  if (status === 'approved') {
    const [requester, invite] = await Promise.all([
      getUser(c.env.DB, request.userId),
      request.inviteId ? getInvite(c.env.DB, request.inviteId) : null,
    ]);
    member = await getMember(c.env.DB, space.id, request.userId);
    if (member?.bannedAt != null) throw new ApiError(403, 'banned', { spaceId: space.id });
    if (requester) {
      // Without the invite row (it never goes away today), approve as a watch-only guest.
      const grant = await grantStatements(
        c.env.DB,
        invite ?? {
          id: '',
          spaceId: space.id,
          roomId: request.roomId,
          role: 'guest',
          canStream: false,
          createdBy: null,
        },
        requester,
        member,
        now,
      );
      statements.push(...grant.statements);
      roleChanged = grant.roleChanged;
    }
  }
  await c.env.DB.batch(statements);
  if (roleChanged && member) await syncUser(c.env, space.id, request.userId, 'role_changed');
  if (status === 'approved' && request.roomId !== null) {
    await syncUser(c.env, space.id, request.userId, 'access_revoked', [request.roomId]);
  }
  return c.json({ joinRequest: await getJoinRequest(c.env.DB, request.id) });
}

/** POST /api/join-requests/:id/approve|reject (owners and admins). */
joinRequests.post('/join-requests/:joinRequestId/approve', (c) => decide(c, 'approved'));
joinRequests.post('/join-requests/:joinRequestId/reject', (c) => decide(c, 'rejected'));
