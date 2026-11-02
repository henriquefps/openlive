// SPDX-License-Identifier: AGPL-3.0-only
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { DEV_USER_HEADER } from '../src/room/identity';
import {
  addMember,
  auditRows,
  call,
  fixedRoom,
  migrate,
  newUser,
  setAccess,
  world,
} from './api-helpers';
import { Client } from './room-helpers';

beforeAll(migrate);

describe('authentication', () => {
  it('answers 401 without an identity or for an unknown user', async () => {
    expect(await call('GET', '/me')).toEqual({ status: 401, body: { code: 'unauthenticated' } });
    expect((await call('GET', '/me', 'u_nobody')).status).toBe(401);
  });

  it('fails closed when DEV_AUTH is not "1"', async () => {
    const user = await newUser('dev');
    for (const DEV_AUTH of [undefined, '0']) {
      const request = new Request('http://localhost/api/me', {
        headers: { [DEV_USER_HEADER]: user },
      });
      const res = await worker.fetch(request, { ...env, DEV_AUTH }, createExecutionContext());
      expect(res.status).toBe(401);
    }
  });

  it('keeps 404 not_found for unknown routes', async () => {
    expect(await call('GET', '/nope')).toEqual({ status: 404, body: { code: 'not_found' } });
  });
});

describe('GET /api/me', () => {
  it('returns the user and their memberships', async () => {
    const w = await world();
    const res = await call('GET', '/me', w.admin);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: w.admin, isPlatformAdmin: false });
    expect(res.body.memberships).toEqual([
      expect.objectContaining({ spaceId: w.spaceId, role: 'admin' }),
    ]);
  });
});

describe('spaces', () => {
  it('creates a space with the creator as owner, audited', async () => {
    const user = await newUser('creator');
    const slug = `mine-${crypto.randomUUID().slice(0, 6)}`;
    const res = await call('POST', '/spaces', user, { name: 'Mine', slug });
    expect(res.status).toBe(201);
    expect(res.body.space).toMatchObject({ name: 'Mine', slug, ownerId: user, role: 'owner' });
    expect(res.body.space.effectiveSettings).toMatchObject({ maxViewersPerStream: 6 });
    const spaceId = res.body.space.id;
    expect((await auditRows(spaceId)).map((r) => r.action)).toEqual(['space.create']);

    const again = await call('POST', '/spaces', user, { name: 'Other', slug });
    expect(again).toEqual({ status: 409, body: { code: 'slug_taken', slug } });
  });

  it('follows the space creation policy: admin_only (default) or members', async () => {
    const w = await world();
    const platformAdmin = await newUser('padmin', { platformAdmin: true });
    const create = (userId: string) =>
      call('POST', '/spaces', userId, {
        name: 'New',
        slug: `new-${crypto.randomUUID().slice(0, 6)}`,
      });
    const everyone = [w.owner, w.admin, w.member, w.guest, w.outsider];
    try {
      await setAccess(null);
      for (const userId of everyone) {
        expect(await create(userId)).toEqual({
          status: 403,
          body: { code: 'space_creation_restricted' },
        });
        expect((await call('GET', '/me', userId)).body.canCreateSpace).toBe(false);
      }
      expect((await create(platformAdmin)).status).toBe(201);
      expect((await call('GET', '/me', platformAdmin)).body.canCreateSpace).toBe(true);

      await setAccess({ signup: 'invite_only', spaceCreation: 'members' });
      for (const userId of [...everyone, platformAdmin]) {
        expect((await create(userId)).status).toBe(201);
        expect((await call('GET', '/me', userId)).body.canCreateSpace).toBe(true);
      }
    } finally {
      await setAccess({ signup: 'open', spaceCreation: 'members' });
    }
  });

  it('validates the body with a JSON Pointer', async () => {
    const user = await newUser('creator');
    const res = await call('POST', '/spaces', user, { name: 'X', slug: 'Bad Slug' });
    expect(res).toEqual({ status: 400, body: { code: 'invalid_message', path: '/slug' } });
  });

  it('lists only my spaces and hides others as 404', async () => {
    const w = await world();
    const list = await call('GET', '/spaces', w.guest);
    expect(list.body.spaces.map((s: { id: string }) => s.id)).toEqual([w.spaceId]);
    expect((await call('GET', `/spaces/${w.spaceId}`, w.guest)).status).toBe(200);
    expect(await call('GET', `/spaces/${w.spaceId}`, w.outsider)).toEqual({
      status: 404,
      body: { code: 'space_not_found', spaceId: w.spaceId },
    });
  });

  it('updates settings within the platform ceilings (owner and admin only)', async () => {
    const w = await world();
    const path = `/spaces/${w.spaceId}`;
    const denied = await call('PATCH', path, w.member, { name: 'Nope' });
    expect(denied).toEqual({ status: 403, body: { code: 'forbidden', spaceId: w.spaceId } });

    const ok = await call('PATCH', path, w.admin, {
      name: 'Renamed',
      settings: { maxViewersPerStream: 4, membersCanInviteGuests: false },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.space).toMatchObject({
      name: 'Renamed',
      settings: { maxViewersPerStream: 4, membersCanInviteGuests: false },
      effectiveSettings: { maxViewersPerStream: 4 },
    });

    const tooHigh = await call('PATCH', path, w.admin, { settings: { maxViewersPerStream: 7 } });
    expect(tooHigh).toEqual({
      status: 400,
      body: { code: 'setting_above_ceiling', path: '/settings/maxViewersPerStream', limit: 6 },
    });
    const preset = await call('PATCH', path, w.admin, { settings: { allowedPresets: ['native'] } });
    expect(preset.body).toEqual({ code: 'preset_not_allowed', preset: 'native' });

    // null removes the override.
    const cleared = await call('PATCH', path, w.owner, { settings: { maxViewersPerStream: null } });
    expect(cleared.body.space.settings).toEqual({ membersCanInviteGuests: false });
    expect((await auditRows(w.spaceId, 'space.update')).length).toBe(2);
  });

  it('reads the ceilings from platform_settings', async () => {
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('room_limits', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
      .bind(JSON.stringify({ maxViewersPerStream: 10 }), Date.now())
      .run();
    try {
      const w = await world();
      const res = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
        settings: { maxViewersPerStream: 9 },
      });
      expect(res.status).toBe(200);
      const over = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
        settings: { maxViewersPerStream: 11 },
      });
      expect(over.body).toMatchObject({ code: 'setting_above_ceiling', limit: 10 });
    } finally {
      await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'room_limits'").run();
    }
  });

  it('deletes a space (owner only) and closes its open rooms', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const { client } = await Client.join(roomId, w.member);
    expect((await call('DELETE', `/spaces/${w.spaceId}`, w.admin)).status).toBe(403);
    expect((await call('DELETE', `/spaces/${w.spaceId}`, w.owner)).status).toBe(204);
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'deleted' });
    expect((await client.closed).code).toBe(4005);
    expect((await call('GET', `/spaces/${w.spaceId}`, w.owner)).status).toBe(404);
    expect((await auditRows(w.spaceId, 'space.delete')).length).toBe(1);
  });

  it('transfers ownership: the old owner becomes admin', async () => {
    const w = await world();
    const path = `/spaces/${w.spaceId}/transfer`;
    expect((await call('POST', path, w.admin, { userId: w.member })).status).toBe(403);
    expect((await call('POST', path, w.owner, { userId: w.guest })).status).toBe(403);
    expect(await call('POST', path, w.owner, { userId: w.outsider })).toEqual({
      status: 404,
      body: { code: 'member_not_found', userId: w.outsider },
    });

    const res = await call('POST', path, w.owner, { userId: w.member });
    expect(res.status).toBe(200);
    expect(res.body.space).toMatchObject({ ownerId: w.member, role: 'admin' });
    const members = await call('GET', `/spaces/${w.spaceId}/members`, w.member);
    const roles = Object.fromEntries(
      members.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]),
    );
    expect(roles[w.member]).toBe('owner');
    expect(roles[w.owner]).toBe('admin');
    expect(await auditRows(w.spaceId, 'space.transfer')).toEqual([
      expect.objectContaining({ actor_id: w.owner, target: w.member }),
    ]);
  });

  it('a platform admin without membership does not see a space', async () => {
    const w = await world();
    const admin = await newUser('platform', { platformAdmin: true });
    expect((await call('GET', `/spaces/${w.spaceId}`, admin)).status).toBe(404);
    await addMember(w.spaceId, admin, 'guest');
    expect((await call('GET', `/spaces/${w.spaceId}`, admin)).status).toBe(200);
  });
});
