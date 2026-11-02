// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/db/util';
import { auditRows, call, fixedRoom, migrate, newUser, type World, world } from './api-helpers';

beforeAll(migrate);

async function invite(w: World, by: string, body: Record<string, unknown> = {}) {
  const res = await call('POST', `/spaces/${w.spaceId}/invites`, by, body);
  if (res.status !== 201) throw new Error(`invite failed: ${JSON.stringify(res.body)}`);
  return res.body as { invite: { id: string; expiresAt: number }; token: string };
}

const accept = (token: string, userId: string) => call('POST', `/invites/${token}/accept`, userId);

async function roleOf(spaceId: string, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT role FROM space_members WHERE space_id = ? AND user_id = ?',
  )
    .bind(spaceId, userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

describe('creating invites (matrix: who invites whom)', () => {
  it('returns the token once and stores only its SHA-256', async () => {
    const w = await world();
    const before = Date.now();
    const { invite: inv, token } = await invite(w, w.admin, { role: 'member' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inv).toMatchObject({ role: 'member', maxUses: 1, uses: 0, requiresApproval: false });
    expect(inv).not.toHaveProperty('token');
    // Default validity: 7 days.
    expect(inv.expiresAt - before).toBeGreaterThanOrEqual(7 * 24 * 3_600_000 - 1000);
    const row = await env.DB.prepare('SELECT token_hash FROM invites WHERE id = ?')
      .bind(inv.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(await auditRows(w.spaceId, 'invite.create')).toEqual([
      expect.objectContaining({ actor_id: w.admin, target: inv.id }),
    ]);
  });

  it('members invite guests but not members; guests invite nobody', async () => {
    const w = await world();
    const path = `/spaces/${w.spaceId}/invites`;
    expect((await call('POST', path, w.member, { role: 'guest' })).status).toBe(201);
    expect((await call('POST', path, w.member, { role: 'member' })).status).toBe(403);
    expect((await call('POST', path, w.guest, { role: 'guest' })).status).toBe(403);
    expect((await call('POST', path, w.outsider, {})).status).toBe(404);
  });

  it('the space can turn off guest invites by members', async () => {
    const w = await world();
    await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
      settings: { membersCanInviteGuests: false },
    });
    expect((await call('POST', `/spaces/${w.spaceId}/invites`, w.member, {})).status).toBe(403);
    expect((await call('POST', `/spaces/${w.spaceId}/invites`, w.admin, {})).status).toBe(201);
  });

  it('a room invite is for guests, and carries the stream permission only if the inviter has it', async () => {
    const w = await world();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    const path = `/spaces/${w.spaceId}/invites`;
    expect((await call('POST', path, w.admin, { roomId, role: 'member' })).body).toEqual({
      code: 'invalid_message',
      path: '/role',
    });
    expect((await call('POST', path, w.admin, { canStream: true })).body).toEqual({
      code: 'invalid_message',
      path: '/canStream',
    });
    // A member who cannot see the restricted room cannot invite to it.
    expect((await call('POST', path, w.member, { roomId })).status).toBe(403);
    expect((await call('POST', path, w.admin, { roomId, canStream: true })).status).toBe(201);
    const other = await world();
    expect((await call('POST', path, w.admin, { roomId: await fixedRoom(other) })).status).toBe(
      404,
    );
  });
});

describe('accepting invites', () => {
  it('a space invite makes a member, single use, audited', async () => {
    const w = await world();
    const { invite: inv, token } = await invite(w, w.member);
    const user = await newUser('newcomer');
    const res = await accept(token, user);
    expect(res).toEqual({
      status: 200,
      body: { status: 'joined', spaceId: w.spaceId, roomId: null, role: 'guest' },
    });
    expect(await roleOf(w.spaceId, user)).toBe('guest');
    const member = await env.DB.prepare(
      'SELECT invited_by FROM space_members WHERE space_id = ? AND user_id = ?',
    )
      .bind(w.spaceId, user)
      .first<{ invited_by: string }>();
    expect(member?.invited_by).toBe(w.member);
    expect(await auditRows(w.spaceId, 'invite.accept')).toEqual([
      expect.objectContaining({ actor_id: user, target: inv.id }),
    ]);

    expect((await accept(token, await newUser('late'))).body).toEqual({ code: 'invite_exhausted' });
    expect((await accept(token, user)).body).toEqual({ code: 'invite_exhausted' });
  });

  it('honours max_uses', async () => {
    const w = await world();
    const { token } = await invite(w, w.admin, { maxUses: 2 });
    expect((await accept(token, await newUser('a'))).status).toBe(200);
    expect((await accept(token, await newUser('b'))).status).toBe(200);
    expect(await accept(token, await newUser('c'))).toEqual({
      status: 410,
      body: { code: 'invite_exhausted' },
    });
  });

  it('refuses expired, revoked and unknown invites', async () => {
    const w = await world();
    const expired = await invite(w, w.admin);
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expired.invite.id)
      .run();
    const user = await newUser('x');
    expect(await accept(expired.token, user)).toEqual({
      status: 410,
      body: { code: 'invite_expired' },
    });

    const revoked = await invite(w, w.admin);
    expect((await call('DELETE', `/invites/${revoked.invite.id}`, w.admin)).status).toBe(204);
    expect((await accept(revoked.token, user)).body).toEqual({ code: 'invite_revoked' });
    expect((await auditRows(w.spaceId, 'invite.revoke')).length).toBe(1);

    expect(await accept('A'.repeat(43), user)).toEqual({
      status: 404,
      body: { code: 'invite_not_found' },
    });
    expect((await accept('short', user)).status).toBe(404);
  });

  it('refuses people who are banned or already have that role, without using it up', async () => {
    const w = await world();
    const { token } = await invite(w, w.admin);
    expect(await accept(token, w.member)).toEqual({
      status: 409,
      body: { code: 'already_member' },
    });
    await call('POST', `/spaces/${w.spaceId}/members/${w.member2}/ban`, w.admin);
    expect(await accept(token, w.member2)).toEqual({
      status: 403,
      body: { code: 'banned', spaceId: w.spaceId },
    });
    // Still usable once.
    expect((await accept(token, await newUser('fresh'))).status).toBe(200);
  });

  it('a member invite raises a guest to member', async () => {
    const w = await world();
    const { token } = await invite(w, w.owner, { role: 'member' });
    expect((await accept(token, w.guest)).status).toBe(200);
    expect(await roleOf(w.spaceId, w.guest)).toBe('member');
  });

  it('a room invite makes a guest of that room only, managed by the inviter', async () => {
    const w = await world();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    const other = await fixedRoom(w, { visibility: 'restricted' });
    const { token } = await invite(w, w.admin, { roomId, canStream: true });
    const user = await newUser('roomguest');
    expect((await accept(token, user)).body).toMatchObject({ status: 'joined', roomId });
    expect(await roleOf(w.spaceId, user)).toBeNull();
    expect((await call('GET', `/rooms/${roomId}`, user)).status).toBe(200);
    expect((await call('GET', `/rooms/${other}`, user)).status).toBe(403);
    expect((await call('GET', `/spaces/${w.spaceId}`, user)).status).toBe(404);
    const access = await call('GET', `/rooms/${roomId}/access`, w.admin);
    expect(access.body.access).toEqual([
      expect.objectContaining({ userId: user, canStream: true, grantedBy: w.admin }),
    ]);
  });
});

describe('approval flow', () => {
  it('an invite that needs approval files a join request; an admin approves it', async () => {
    const w = await world();
    const { invite: inv, token } = await invite(w, w.member, { requiresApproval: true });
    const user = await newUser('applicant');
    const res = await accept(token, user);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'pending',
      joinRequest: { userId: user, inviteId: inv.id, status: 'pending' },
    });
    expect(await roleOf(w.spaceId, user)).toBeNull();
    // Asking again returns the same pending request and does not take another use.
    const again = await accept(token, user);
    expect(again.status).toBe(202);
    expect(again.body.joinRequest.id).toBe(res.body.joinRequest.id);

    const list = `/spaces/${w.spaceId}/join-requests`;
    expect((await call('GET', list, w.member)).status).toBe(403);
    const pending = await call('GET', list, w.admin);
    expect(pending.body.joinRequests).toEqual([
      expect.objectContaining({ id: res.body.joinRequest.id, displayName: 'Name applicant' }),
    ]);

    const id = res.body.joinRequest.id;
    expect((await call('POST', `/join-requests/${id}/approve`, w.member)).status).toBe(403);
    const approved = await call('POST', `/join-requests/${id}/approve`, w.admin);
    expect(approved.status).toBe(200);
    expect(approved.body.joinRequest).toMatchObject({ status: 'approved', decidedBy: w.admin });
    expect(await roleOf(w.spaceId, user)).toBe('guest');
    expect(await call('POST', `/join-requests/${id}/reject`, w.admin)).toEqual({
      status: 409,
      body: { code: 'join_request_decided', joinRequestId: id },
    });
    expect(
      (await auditRows(w.spaceId)).map((r) => r.action).filter((a) => a.startsWith('join_')),
    ).toEqual(['join_request.create', 'join_request.approve']);
  });

  it('a rejected request gives nothing', async () => {
    const w = await world();
    const { token } = await invite(w, w.admin, { requiresApproval: true, maxUses: 5 });
    const user = await newUser('rejected');
    const { body } = await accept(token, user);
    const res = await call('POST', `/join-requests/${body.joinRequest.id}/reject`, w.owner);
    expect(res.body.joinRequest.status).toBe('rejected');
    expect(await roleOf(w.spaceId, user)).toBeNull();
    expect((await call('GET', `/spaces/${w.spaceId}/join-requests`, w.owner)).body).toEqual({
      joinRequests: [],
    });
    expect((await call('POST', '/join-requests/jr_missing/approve', w.owner)).status).toBe(404);
  });
});

describe('listing and revoking invites', () => {
  it('admins see every invite, members only their own', async () => {
    const w = await world();
    const mine = await invite(w, w.member);
    const theirs = await invite(w, w.admin);
    const ids = async (user: string) =>
      (await call('GET', `/spaces/${w.spaceId}/invites`, user)).body.invites.map(
        (i: { id: string }) => i.id,
      );
    expect(await ids(w.admin)).toEqual([mine.invite.id, theirs.invite.id]);
    expect(await ids(w.member)).toEqual([mine.invite.id]);
    expect((await call('GET', `/spaces/${w.spaceId}/invites`, w.guest)).status).toBe(403);

    expect((await call('DELETE', `/invites/${theirs.invite.id}`, w.member)).status).toBe(403);
    expect((await call('DELETE', `/invites/${mine.invite.id}`, w.member)).status).toBe(204);
    expect(await ids(w.admin)).toEqual([theirs.invite.id]);
    expect((await call('DELETE', '/invites/in_missing', w.admin)).body).toEqual({
      code: 'invite_not_found',
      inviteId: 'in_missing',
    });
  });
});

describe('previewing an invite (GET /api/invites/:token)', () => {
  it('shows what the invite gives, and refuses like accept', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const { token } = await invite(w, w.admin, { roomId, canStream: true, requiresApproval: true });
    const user = await newUser('visitor');
    const preview = await call('GET', `/invites/${token}`, user);
    expect(preview).toEqual({
      status: 200,
      body: {
        invite: {
          spaceName: 'Friends',
          roomName: 'Game night',
          role: 'guest',
          canStream: true,
          requiresApproval: true,
          expiresAt: expect.any(Number),
        },
        pending: false,
      },
    });
    // A pending request is shown even once the single use is taken.
    expect((await accept(token, user)).status).toBe(202);
    expect((await call('GET', `/invites/${token}`, user)).body).toMatchObject({ pending: true });
    expect((await call('GET', `/invites/${token}`, await newUser('other'))).body).toEqual({
      code: 'invite_exhausted',
    });
    expect((await call('GET', `/invites/${'x'.repeat(43)}`, user)).status).toBe(404);
  });
});
