// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditRows, call, fixedRoom, migrate, world } from './api-helpers';
import { Client } from './room-helpers';

beforeAll(migrate);

const HOUR = 3_600_000;

describe('fixed rooms', () => {
  it('owners and admins create them; members and guests cannot', async () => {
    const w = await world();
    const path = `/spaces/${w.spaceId}/rooms`;
    for (const user of [w.member, w.guest]) {
      const res = await call('POST', path, user, { name: 'R', slug: 'r' });
      expect(res).toEqual({ status: 403, body: { code: 'forbidden', spaceId: w.spaceId } });
    }
    const res = await call('POST', path, w.admin, { name: 'Game night', slug: 'game-night' });
    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({
      kind: 'fixed',
      slug: 'game-night',
      visibility: 'space',
      expiresAt: null,
      effectiveSettings: { maxStreams: 5, maxViewersPerStream: 6 },
    });
    const dup = await call('POST', path, w.owner, { name: 'Again', slug: 'game-night' });
    expect(dup).toEqual({ status: 409, body: { code: 'slug_taken', slug: 'game-night' } });
    expect(await auditRows(w.spaceId, 'room.create')).toEqual([
      expect.objectContaining({ actor_id: w.admin, target: res.body.room.id }),
    ]);
  });

  it('room limits stay within the space limits', async () => {
    const w = await world();
    await call('PATCH', `/spaces/${w.spaceId}`, w.owner, { settings: { maxViewersPerStream: 4 } });
    const res = await call('POST', `/spaces/${w.spaceId}/rooms`, w.owner, {
      name: 'R',
      slug: 'r',
      settings: { maxViewersPerStream: 5 },
    });
    expect(res.body).toEqual({
      code: 'setting_above_ceiling',
      path: '/settings/maxViewersPerStream',
      limit: 4,
    });
    const roomId = await fixedRoom(w, { settings: { maxViewersPerStream: 3 } });
    const get = await call('GET', `/rooms/${roomId}`, w.guest);
    expect(get.body.room.effectiveSettings.maxViewersPerStream).toBe(3);
  });

  it('lists only the rooms the caller may see (restricted visibility)', async () => {
    const w = await world();
    const open = await fixedRoom(w);
    const restricted = await fixedRoom(w, { visibility: 'restricted' });
    const ids = async (user: string) =>
      (await call('GET', `/spaces/${w.spaceId}/rooms`, user)).body.rooms.map(
        (r: { id: string }) => r.id,
      );
    expect(await ids(w.admin)).toEqual([open, restricted]);
    expect(await ids(w.member)).toEqual([open]);
    expect((await call('GET', `/rooms/${restricted}`, w.member)).body).toEqual({
      code: 'forbidden',
      roomId: restricted,
    });
    expect((await call('GET', `/spaces/${w.spaceId}/rooms`, w.outsider)).status).toBe(404);
    expect((await call('GET', `/rooms/r_missing`, w.owner)).status).toBe(404);
  });

  it('updates a room; switching to restricted revokes members without a grant (4003)', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const { client } = await Client.join(roomId, w.member);
    expect((await call('PATCH', `/rooms/${roomId}`, w.member, { name: 'X' })).status).toBe(403);
    const res = await call('PATCH', `/rooms/${roomId}`, w.admin, {
      name: 'Private',
      visibility: 'restricted',
    });
    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ name: 'Private', visibility: 'restricted' });
    expect((await client.take('error')).payload).toEqual({ code: 'forbidden', roomId });
    expect((await client.closed).code).toBe(4003);
    expect((await auditRows(w.spaceId, 'room.update')).length).toBe(1);
  });

  it('archives a room: sockets get room.closed archived (4005), the room is gone', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const { client } = await Client.join(roomId, w.guest);
    expect((await call('DELETE', `/rooms/${roomId}`, w.member)).status).toBe(403);
    expect((await call('DELETE', `/rooms/${roomId}`, w.admin)).status).toBe(204);
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'archived' });
    expect((await client.closed).code).toBe(4005);
    expect((await call('GET', `/rooms/${roomId}`, w.owner)).body).toEqual({
      code: 'room_closed',
      roomId,
    });
    expect((await call('PATCH', `/rooms/${roomId}`, w.owner, { name: 'Y' })).status).toBe(410);
    expect((await auditRows(w.spaceId, 'room.archive')).length).toBe(1);
  });
});

describe('quick rooms', () => {
  it('members create them with a code and the space expiry; guests cannot', async () => {
    const w = await world();
    expect((await call('POST', '/rooms/quick', w.guest, { spaceId: w.spaceId })).status).toBe(403);
    expect((await call('POST', '/rooms/quick', w.outsider, { spaceId: w.spaceId })).status).toBe(
      404,
    );

    await call('PATCH', `/spaces/${w.spaceId}`, w.owner, { settings: { quickRoomHours: 2 } });
    const before = Date.now();
    const res = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^OL-\d{4}-\d{4}$/);
    const room = res.body.room;
    expect(room).toMatchObject({ kind: 'quick', slug: res.body.code.toLowerCase() });
    expect(room.expiresAt).toBeGreaterThanOrEqual(before + 2 * HOUR);
    expect(room.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * HOUR);

    // The room socket carries the expiry the RoomDO schedules its alarm on.
    const { client, welcome } = await Client.join(room.id, w.guest);
    expect(welcome.room.expiresAt).toBe(room.expiresAt);
    client.close();
  });

  it('the creator or an admin ends it early; another member cannot', async () => {
    const w = await world();
    const res = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId, name: 'Look' });
    const roomId = res.body.room.id;
    const { client } = await Client.join(roomId, w.member2);
    expect((await call('DELETE', `/rooms/${roomId}`, w.member2)).status).toBe(403);
    expect((await call('PATCH', `/rooms/${roomId}`, w.member, { name: 'Renamed' })).status).toBe(
      200,
    );
    expect((await call('DELETE', `/rooms/${roomId}`, w.member)).status).toBe(204);
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'ended_by_owner' });
  });

  it('refuses a space quickRoomHours above the cap', async () => {
    const w = await world();
    const res = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
      settings: { quickRoomHours: 48 },
    });
    expect(res.body).toEqual({
      code: 'setting_above_ceiling',
      path: '/settings/quickRoomHours',
      limit: 24,
    });
  });
});

describe('room_access', () => {
  it('admins grant view on a restricted room; members cannot', async () => {
    const w = await world();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    const path = `/rooms/${roomId}/access/${w.member}`;
    expect((await call('PUT', path, w.member2, {})).status).toBe(403);
    const res = await call('PUT', path, w.admin, {});
    expect(res.status).toBe(200);
    expect(res.body.access).toMatchObject({ userId: w.member, canView: true, canStream: false });
    expect((await call('GET', `/rooms/${roomId}`, w.member)).status).toBe(200);
    const list = await call('GET', `/rooms/${roomId}/access`, w.admin);
    expect(list.body.access).toEqual([expect.objectContaining({ userId: w.member })]);
    expect((await call('GET', `/rooms/${roomId}/access`, w.member)).status).toBe(403);
    expect(await auditRows(w.spaceId, 'room_access.grant')).toEqual([
      expect.objectContaining({ actor_id: w.admin, target: w.member }),
    ]);
  });

  it('revoking view of a restricted room closes the socket with 4003', async () => {
    const w = await world();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    await call('PUT', `/rooms/${roomId}/access/${w.member}`, w.admin, {});
    const { client } = await Client.join(roomId, w.member);
    expect((await call('DELETE', `/rooms/${roomId}/access/${w.member}`, w.admin)).status).toBe(204);
    expect((await client.take('error')).payload).toEqual({ code: 'forbidden', roomId });
    expect((await client.closed).code).toBe(4003);
    expect((await auditRows(w.spaceId, 'room_access.revoke')).length).toBe(1);
  });

  it("the inviter gives their guest the stream permission, with expiry; others can't", async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    // world(): the guest was invited by w.member.
    const path = `/rooms/${roomId}/access/${w.guest}`;
    const { client, welcome } = await Client.join(roomId, w.guest);
    expect(welcome.you.permissions.canStream).toBe(false);
    // Making the grant row (view) is room management...
    expect((await call('PUT', path, w.admin, {})).status).toBe(200);
    expect((await client.take('permissions.changed')).payload.you.permissions.canStream).toBe(
      false,
    );
    // ...the stream permission is guest.stream.set: not for a member who did not invite them.
    const until = Date.now() + HOUR;
    expect((await call('PUT', path, w.member2, { canStream: true, expiresAt: until })).status).toBe(
      403,
    );
    const res = await call('PUT', path, w.member, { canStream: true, expiresAt: until });
    expect(res.status).toBe(200);
    expect(res.body.access).toMatchObject({ canStream: true, expiresAt: until });
    const changed = await client.take('permissions.changed');
    expect(changed.payload.you.permissions.canStream).toBe(true);

    // Revoking is always allowed to the inviter, and the socket follows.
    await call('PUT', path, w.member, { canStream: false, expiresAt: until });
    expect((await client.take('permissions.changed')).payload.you.permissions.canStream).toBe(
      false,
    );
    client.close();
  });

  it('the stream permission is only for guests, and never in the past', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const member = await call('PUT', `/rooms/${roomId}/access/${w.member2}`, w.owner, {
      canStream: true,
    });
    expect(member.status).toBe(403);
    const past = await call('PUT', `/rooms/${roomId}/access/${w.guest}`, w.owner, {
      canStream: true,
      expiresAt: Date.now() - 1,
    });
    expect(past.body).toEqual({ code: 'invalid_message', path: '/expiresAt' });
    const unknown = await call('PUT', `/rooms/${roomId}/access/u_nobody`, w.owner, {});
    expect(unknown).toEqual({ status: 404, body: { code: 'user_not_found', userId: 'u_nobody' } });
  });

  it("revoking a room-only guest's grant kicks them (4004 access_revoked)", async () => {
    const w = await world();
    const roomId = await fixedRoom(w, { visibility: 'restricted' });
    await call('PUT', `/rooms/${roomId}/access/${w.outsider}`, w.owner, {});
    const { client, welcome } = await Client.join(roomId, w.outsider);
    expect(welcome.you.role).toBe('guest');
    await call('DELETE', `/rooms/${roomId}/access/${w.outsider}`, w.owner);
    expect((await client.take('kicked')).payload).toEqual({ reason: 'access_revoked' });
    expect((await client.closed).code).toBe(4004);
    const row = await env.DB.prepare('SELECT 1 FROM room_access WHERE room_id = ?')
      .bind(roomId)
      .first();
    expect(row).toBeNull();
  });
});
