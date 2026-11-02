// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, auditRows, call, fixedRoom, migrate, newUser, world } from './api-helpers';
import { Client } from './room-helpers';

beforeAll(migrate);

const memberPath = (spaceId: string, userId: string) => `/spaces/${spaceId}/members/${userId}`;

describe('members', () => {
  it('lists members; banned ones only for owners and admins', async () => {
    const w = await world();
    await call('POST', `${memberPath(w.spaceId, w.member2)}/ban`, w.admin);
    const asGuest = await call('GET', `/spaces/${w.spaceId}/members`, w.guest);
    expect(asGuest.status).toBe(200);
    expect(asGuest.body.members.map((m: { userId: string }) => m.userId)).not.toContain(w.member2);
    const asAdmin = await call('GET', `/spaces/${w.spaceId}/members`, w.admin);
    expect(asAdmin.body.members).toContainEqual(
      expect.objectContaining({ userId: w.member2, bannedAt: expect.any(Number) }),
    );
    expect((await call('GET', `/spaces/${w.spaceId}/members`, w.outsider)).status).toBe(404);
  });

  describe('role changes (matrix: owner any, admin up to member)', () => {
    it('owner promotes a member to admin, audited', async () => {
      const w = await world();
      const res = await call('PATCH', memberPath(w.spaceId, w.member), w.owner, { role: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body.member).toMatchObject({ userId: w.member, role: 'admin' });
      const [row] = await auditRows(w.spaceId, 'member.role.change');
      expect(row).toMatchObject({ actor_id: w.owner, target: w.member });
      expect(JSON.parse(row?.data_json ?? '{}')).toEqual({ from: 'member', to: 'admin' });
    });

    it('admin promotes a guest to member but not anyone to admin', async () => {
      const w = await world();
      const path = memberPath(w.spaceId, w.guest);
      expect((await call('PATCH', path, w.admin, { role: 'member' })).status).toBe(200);
      const res = await call('PATCH', memberPath(w.spaceId, w.member2), w.admin, { role: 'admin' });
      expect(res).toEqual({ status: 403, body: { code: 'forbidden', spaceId: w.spaceId } });
    });

    it('admin cannot act on the owner or another admin; members cannot change roles', async () => {
      const w = await world();
      const admin2 = await newUser('admin2');
      await addMember(w.spaceId, admin2, 'admin');
      for (const [actor, target] of [
        [w.admin, w.owner],
        [w.admin, admin2],
        [w.member, w.guest],
        [w.guest, w.member],
      ] as const) {
        const res = await call('PATCH', memberPath(w.spaceId, target), actor, { role: 'guest' });
        expect(res.status, `${actor} -> ${target}`).toBe(403);
      }
    });

    it('nobody becomes owner by a role change', async () => {
      const w = await world();
      const res = await call('PATCH', memberPath(w.spaceId, w.member), w.owner, { role: 'owner' });
      expect(res).toEqual({ status: 400, body: { code: 'invalid_message', path: '/role' } });
    });

    it('an unknown target is 404 only for someone allowed to act', async () => {
      const w = await world();
      const path = memberPath(w.spaceId, w.outsider);
      expect((await call('PATCH', path, w.member, { role: 'guest' })).status).toBe(403);
      expect(await call('PATCH', path, w.owner, { role: 'guest' })).toEqual({
        status: 404,
        body: { code: 'member_not_found', userId: w.outsider },
      });
    });

    it('a demotion out of a restricted room kicks the open socket (4004 role_changed)', async () => {
      const w = await world();
      const roomId = await fixedRoom(w, { visibility: 'restricted' });
      const { client } = await Client.join(roomId, w.admin);
      const res = await call('PATCH', memberPath(w.spaceId, w.admin), w.owner, { role: 'member' });
      expect(res.status).toBe(200);
      expect((await client.take('kicked')).payload).toEqual({ reason: 'role_changed' });
      expect((await client.closed).code).toBe(4004);
    });

    it('a role change where the room stays visible sends permissions.changed', async () => {
      const w = await world();
      const roomId = await fixedRoom(w);
      const { client } = await Client.join(roomId, w.guest);
      await call('PATCH', memberPath(w.spaceId, w.guest), w.admin, { role: 'member' });
      const msg = await client.take('permissions.changed');
      expect(msg.payload.you).toMatchObject({
        role: 'member',
        permissions: { canStream: true, canModerate: false },
      });
      client.close();
    });
  });

  describe('ban and unban', () => {
    it('a ban kicks the person from every open room (4004 banned) and is audited', async () => {
      const w = await world();
      const [room1, room2] = [await fixedRoom(w), await fixedRoom(w)];
      const a = await Client.join(room1, w.member);
      const b = await Client.join(room2, w.member);
      const res = await call('POST', `${memberPath(w.spaceId, w.member)}/ban`, w.admin);
      expect(res.status).toBe(200);
      expect(res.body.member.bannedAt).toEqual(expect.any(Number));
      for (const { client } of [a, b]) {
        expect((await client.take('kicked')).payload).toEqual({ reason: 'banned' });
        expect((await client.closed).code).toBe(4004);
      }
      // Banned: no more space or rooms.
      expect(await call('GET', `/spaces/${w.spaceId}`, w.member)).toEqual({
        status: 403,
        body: { code: 'banned', spaceId: w.spaceId },
      });
      expect(await auditRows(w.spaceId, 'member.ban')).toEqual([
        expect.objectContaining({ actor_id: w.admin, target: w.member }),
      ]);

      const unban = await call('DELETE', `${memberPath(w.spaceId, w.member)}/ban`, w.admin);
      expect(unban.body.member.bannedAt).toBeNull();
      expect((await call('GET', `/spaces/${w.spaceId}`, w.member)).status).toBe(200);
      expect((await auditRows(w.spaceId, 'member.unban')).length).toBe(1);
    });

    it('admins cannot ban the owner or admins, members cannot ban, nobody bans themselves', async () => {
      const w = await world();
      for (const [actor, target] of [
        [w.admin, w.owner],
        [w.member, w.guest],
        [w.owner, w.owner],
      ] as const) {
        const res = await call('POST', `${memberPath(w.spaceId, target)}/ban`, actor);
        expect(res.status, `${actor} -> ${target}`).toBe(403);
      }
    });
  });

  describe('leave and remove', () => {
    it('a member leaves; their sockets close with 4004 removed', async () => {
      const w = await world();
      const roomId = await fixedRoom(w);
      const { client } = await Client.join(roomId, w.member);
      expect((await call('DELETE', memberPath(w.spaceId, w.member), w.member)).status).toBe(204);
      expect((await client.take('kicked')).payload).toEqual({ reason: 'removed' });
      expect((await call('GET', `/spaces/${w.spaceId}`, w.member)).status).toBe(404);
      expect(await auditRows(w.spaceId, 'member.leave')).toEqual([
        expect.objectContaining({ actor_id: w.member, target: w.member }),
      ]);
    });

    it('the owner must transfer before leaving', async () => {
      const w = await world();
      expect(await call('DELETE', memberPath(w.spaceId, w.owner), w.owner)).toEqual({
        status: 409,
        body: { code: 'owner_must_transfer', spaceId: w.spaceId },
      });
    });

    it('a banned member cannot leave to drop the ban', async () => {
      const w = await world();
      await call('POST', `${memberPath(w.spaceId, w.member)}/ban`, w.owner);
      expect((await call('DELETE', memberPath(w.spaceId, w.member), w.member)).status).toBe(403);
    });

    it('removing someone else follows the ban rule', async () => {
      const w = await world();
      expect((await call('DELETE', memberPath(w.spaceId, w.guest), w.member)).status).toBe(403);
      expect((await call('DELETE', memberPath(w.spaceId, w.owner), w.admin)).status).toBe(403);
      expect((await call('DELETE', memberPath(w.spaceId, w.guest), w.admin)).status).toBe(204);
      expect((await auditRows(w.spaceId, 'member.remove')).length).toBe(1);
    });
  });
});
