// SPDX-License-Identifier: AGPL-3.0-only
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const TABLES = [
  'app_codes',
  'app_tokens',
  'app_ws_tickets',
  'audit_log',
  'auth_rate_events',
  'banned_identities',
  'chat_authors',
  'device_codes',
  'devices',
  'email_tokens',
  'identities',
  'invites',
  'join_requests',
  'platform_settings',
  'realtime_sessions',
  'room_access',
  'rooms',
  'sessions',
  'space_members',
  'spaces',
  'stream_starts',
  'usage_daily',
  'usage_real_daily',
  'user_tutorial',
  'users',
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('0001_initial', () => {
  it('creates every table of the initial schema', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(TABLES);
  });

  it('enforces enum CHECK constraints and foreign keys', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(
        'u1',
        'Ana',
        now,
      ),
      env.DB.prepare(
        'INSERT INTO spaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind('s1', 'Friends', 'friends', 'u1', now),
    ]);

    const insertRoom = (id: string, kind: string, expiresAt: number | null) =>
      env.DB.prepare(
        'INSERT INTO rooms (id, space_id, kind, name, slug, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, 's1', kind, id, id, now, expiresAt)
        .run();

    await expect(insertRoom('r1', 'fixed', null)).resolves.toBeTruthy();
    await expect(insertRoom('r2', 'party', null)).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        "INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ('s1', 'u1', 'superuser', ?)",
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        "INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ('s1', 'ghost', 'member', ?)",
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
