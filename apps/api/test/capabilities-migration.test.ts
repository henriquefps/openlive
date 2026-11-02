// SPDX-License-Identifier: AGPL-3.0-only
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// 0010_room_capabilities: rooms that exist before it become stream-only; a room that already
// stored capabilities keeps them.
describe('0010_room_capabilities', () => {
  it('makes every existing room stream-only and keeps its other settings', async () => {
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < '0010');
    await applyD1Migrations(env.DB, before);
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
      env.DB.prepare(
        'INSERT INTO rooms (id, space_id, kind, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('r1', 's1', 'fixed', 'Lobby', 'lobby', now),
      env.DB.prepare(
        `INSERT INTO rooms (id, space_id, kind, name, slug, settings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('r2', 's1', 'fixed', 'Games', 'games', '{"maxStreams":2}', now),
      env.DB.prepare(
        `INSERT INTO rooms (id, space_id, kind, name, slug, settings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'r3',
        's1',
        'fixed',
        'Talk',
        'talk',
        '{"capabilities":{"stream":false,"voice":true,"camera":false,"text":false}}',
        now,
      ),
    ]);

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare(
      'SELECT id, settings_json FROM rooms ORDER BY id',
    ).all<{ id: string; settings_json: string }>();
    const settings = Object.fromEntries(
      results.map((r) => [r.id, JSON.parse(r.settings_json) as unknown]),
    );
    const streamOnly = { stream: true, voice: false, camera: false, text: false };
    expect(settings).toEqual({
      r1: { capabilities: streamOnly },
      r2: { maxStreams: 2, capabilities: streamOnly },
      r3: { capabilities: { stream: false, voice: true, camera: false, text: false } },
    });
  });
});
