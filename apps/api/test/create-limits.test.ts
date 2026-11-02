// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CREATE_PER_HOUR, type CreateKind, createLimit } from '../src/auth/rate-limit';
import { call, migrate, newUser, type World, world } from './api-helpers';

// Per-user hourly limits on creating spaces, rooms and invites, and on accepting invites
// (L4). Each test fills the bucket to one below the limit
// directly in D1, so it does not have to create dozens of things through the API.

beforeAll(migrate);

const suffix = () => crypto.randomUUID().slice(0, 8);

/** Records `count` creations of `kind` for `userId`, spread over the last half hour. */
async function spend(kind: CreateKind, userId: string, count: number): Promise<void> {
  const { bucket } = createLimit(kind, userId);
  const now = Date.now();
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB.prepare('INSERT INTO auth_rate_events (bucket, created_at) VALUES (?, ?)').bind(
        bucket,
        now - 30 * 60 * 1000 + i,
      ),
    ),
  );
}

function expectLimited(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status).toBe(429);
  expect(res.body).toEqual({ code: 'rate_limited', retryAfterMs: expect.any(Number) });
  // The oldest counted creation leaves the window in about half an hour.
  expect(res.body['retryAfterMs']).toBeGreaterThan(29 * 60 * 1000);
  expect(res.body['retryAfterMs']).toBeLessThanOrEqual(30 * 60 * 1000);
}

const newSpace = (userId: string) =>
  call('POST', '/spaces', userId, { name: 'Friends', slug: `s-${suffix()}` });
const newFixed = (w: World, userId: string) =>
  call('POST', `/spaces/${w.spaceId}/rooms`, userId, { name: 'Room', slug: `r-${suffix()}` });
const newQuick = (w: World, userId: string) =>
  call('POST', '/rooms/quick', userId, { spaceId: w.spaceId });
const newInvite = (w: World, userId: string) =>
  call('POST', `/spaces/${w.spaceId}/invites`, userId, { role: 'member' });

describe('creation rate limits', () => {
  it('are generous for a group of friends', () => {
    expect(CREATE_PER_HOUR).toEqual({ space: 10, room: 30, invite: 30, inviteAccept: 30 });
  });

  it('limits spaces per person per hour', async () => {
    const user = await newUser('spaces');
    await spend('space', user, CREATE_PER_HOUR.space - 1);
    expect((await newSpace(user)).status).toBe(201);
    expectLimited(await newSpace(user));
    // Someone else is not affected.
    expect((await newSpace(await newUser('other'))).status).toBe(201);
  });

  it('limits fixed and quick rooms together', async () => {
    const w = await world();
    await spend('room', w.owner, CREATE_PER_HOUR.room - 2);
    expect((await newFixed(w, w.owner)).status).toBe(201);
    expect((await newQuick(w, w.owner)).status).toBe(201);
    expectLimited(await newFixed(w, w.owner));
    expectLimited(await newQuick(w, w.owner));
    expect((await newQuick(w, w.member)).status).toBe(201);
  });

  it('limits invites per person per hour', async () => {
    const w = await world();
    await spend('invite', w.admin, CREATE_PER_HOUR.invite - 1);
    expect((await newInvite(w, w.admin)).status).toBe(201);
    expectLimited(await newInvite(w, w.admin));
    expect((await newInvite(w, w.owner)).status).toBe(201);
  });

  it('limits accepting invites (and so filing join requests)', async () => {
    const w = await world();
    const create = await call('POST', `/spaces/${w.spaceId}/invites`, w.owner, {
      role: 'member',
      maxUses: 5,
      requiresApproval: true,
    });
    expect(create.status).toBe(201);
    const token = create.body.token as string;
    const person = await newUser('joiner');
    await spend('inviteAccept', person, CREATE_PER_HOUR.inviteAccept);
    expectLimited(await call('POST', `/invites/${token}/accept`, person));
    const other = await newUser('joiner2');
    expect((await call('POST', `/invites/${token}/accept`, other)).status).toBe(202);
  });

  it('does not count a request that is refused before anything is created', async () => {
    const w = await world();
    // A guest may not create fixed rooms: 403, and the bucket stays empty.
    for (let i = 0; i < CREATE_PER_HOUR.room + 1; i++) {
      expect((await newFixed(w, w.guest)).status).toBe(403);
    }
    const { bucket } = createLimit('room', w.guest);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_rate_events WHERE bucket = ?')
      .bind(bucket)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
