// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@openlive/protocol';
import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { DEV_USER_HEADER } from '../src/room/identity';

// REST test helpers. Every test makes its own users and space (unique ids), so tests do not
// depend on each other or on the order they run in.

// Response bodies are checked field by field in the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/**
 * Applies the migrations, then opens sign-up and space creation to everyone, as they were before
 * those policies existed, so tests that are not about them can create users and spaces freely.
 * test/signup-policy.test.ts and the space policy tests set the policies they need.
 */
export async function migrate(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await setAccess({ signup: 'open', spaceCreation: 'members' });
}

/** Writes the platform `access` setting directly (null deletes it: the defaults apply). */
export async function setAccess(
  value: { signup: 'invite_only' | 'open'; spaceCreation: 'admin_only' | 'members' } | null,
): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'access'").run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('access', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(JSON.stringify(value), Date.now())
    .run();
}

const suffix = () => crypto.randomUUID().slice(0, 8);

export async function newUser(label: string, extra: { platformAdmin?: boolean } = {}) {
  const id = `u_${label}_${suffix()}`;
  await env.DB.prepare(
    'INSERT INTO users (id, display_name, is_platform_admin, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, `Name ${label}`, extra.platformAdmin ? 1 : 0, Date.now())
    .run();
  return id;
}

export async function call(
  method: string,
  path: string,
  userId?: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (userId) headers[DEV_USER_HEADER] = userId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export interface World {
  spaceId: string;
  owner: string;
  admin: string;
  member: string;
  member2: string;
  guest: string;
  outsider: string;
}

/** A space created through the API, with one more user per role added directly in D1. */
export async function world(): Promise<World> {
  const owner = await newUser('owner');
  const res = await call('POST', '/spaces', owner, { name: 'Friends', slug: `s-${suffix()}` });
  if (res.status !== 201) throw new Error(`space create failed: ${JSON.stringify(res.body)}`);
  const spaceId = res.body.space.id as string;
  const w: World = {
    spaceId,
    owner,
    admin: await newUser('admin'),
    member: await newUser('member'),
    member2: await newUser('member2'),
    guest: await newUser('guest'),
    outsider: await newUser('outsider'),
  };
  await addMember(spaceId, w.admin, 'admin');
  await addMember(spaceId, w.member, 'member');
  await addMember(spaceId, w.member2, 'member');
  await addMember(spaceId, w.guest, 'guest', w.member);
  return w;
}

export async function addMember(
  spaceId: string,
  userId: string,
  role: Role,
  invitedBy: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO space_members (space_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(spaceId, userId, role, invitedBy, Date.now())
    .run();
}

export async function fixedRoom(
  w: World,
  extra: { visibility?: 'space' | 'restricted'; settings?: Record<string, unknown> } = {},
): Promise<string> {
  const res = await call('POST', `/spaces/${w.spaceId}/rooms`, w.owner, {
    name: 'Game night',
    slug: `r-${suffix()}`,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`room create failed: ${JSON.stringify(res.body)}`);
  return res.body.room.id as string;
}

export interface AuditRow {
  actor_id: string;
  action: string;
  target: string | null;
  data_json: string;
}

export async function auditRows(spaceId: string, action?: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT actor_id, action, target, data_json FROM audit_log
     WHERE space_id = ?1 AND (?2 IS NULL OR action = ?2) ORDER BY created_at, rowid`,
  )
    .bind(spaceId, action ?? null)
    .all<AuditRow>();
  return results;
}
