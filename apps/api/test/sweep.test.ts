// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RETENTION_MS,
  runSweeps,
  SWEEP_LIMITS,
  THUMBNAIL_MIN_AGE_MS,
} from '../src/maintenance/sweep';
import { thumbnailKey } from '../src/room/thumbnails';
import { Client, roomStub, seed, SPACE_ID, testStream, USERS } from './room-helpers';

// The housekeeping cron: idempotent, bounded, logged.

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

async function quickRoom(id: string, expiresAt: number) {
  await env.DB.prepare(
    `INSERT INTO rooms (id, space_id, kind, name, slug, settings_json, created_at, expires_at)
     VALUES (?, ?, 'quick', ?, ?, '{}', ?, ?)`,
  )
    .bind(id, SPACE_ID, id, id, expiresAt - DAY_MS, expiresAt)
    .run();
}

describe('scheduled sweeps', () => {
  it('archives expired quick rooms, closes their room, and is idempotent', async () => {
    const log = quiet();
    const now = Date.now();
    await quickRoom('r_q_expired', now + 60 * 60_000);
    await quickRoom('r_q_live', now + 60 * 60_000);
    // Someone joined while it was open; it expired since and its alarm has not run yet.
    const { client } = await Client.join('r_q_expired', USERS.member1.id);
    await env.DB.prepare("UPDATE rooms SET expires_at = ? WHERE id = 'r_q_expired'")
      .bind(now - 1000)
      .run();

    const first = await runSweeps(env, now);
    expect(first.rooms).toBe(1);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^sweep: rooms=1 invites=\d+ /);
    expect((await client.take('room.closed')).payload.reason).toBe('expired');
    const rows = await env.DB.prepare(
      "SELECT id, archived_at FROM rooms WHERE id IN ('r_q_expired', 'r_q_live') ORDER BY id",
    ).all<{ id: string; archived_at: number | null }>();
    expect(rows.results).toEqual([
      { id: 'r_q_expired', archived_at: now },
      { id: 'r_q_live', archived_at: null },
    ]);
    const lines = log.mock.calls.length;
    const second = await runSweeps(env, now);
    expect(second.rooms).toBe(0);
    // A run that removed nothing logs nothing (each line is a Workers Logs event).
    const removed = Object.values(second).some((v) => typeof v === 'number' && v > 0);
    expect(log.mock.calls.length).toBe(lines + (removed ? 1 : 0));
  });

  it('deletes invites, e-mail tokens and sessions past their retention, nothing usable', async () => {
    quiet();
    const now = Date.now();
    const old = now - RETENTION_MS.invites - 1000;
    const invite = (
      id: string,
      f: { expiresAt: number; uses?: number; revokedAt?: number; createdAt?: number },
    ) =>
      env.DB.prepare(
        `INSERT INTO invites (id, space_id, token_hash, role, max_uses, uses, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, 'member', 1, ?, ?, ?, ?)`,
      ).bind(
        id,
        SPACE_ID,
        `h_${id}`,
        f.uses ?? 0,
        f.expiresAt,
        f.createdAt ?? old,
        f.revokedAt ?? null,
      );
    await env.DB.batch([
      invite('i_expired_old', { expiresAt: old }),
      invite('i_expired_recent', { expiresAt: now - 1000, createdAt: now - 2 * DAY_MS }),
      invite('i_revoked_old', { expiresAt: now + DAY_MS, revokedAt: old }),
      invite('i_used_old', { expiresAt: now + DAY_MS, uses: 1 }),
      invite('i_usable', { expiresAt: now + DAY_MS }),
      env.DB.prepare(
        "INSERT INTO email_tokens (token_hash, email, purpose, expires_at) VALUES ('t_old', 'a@x', 'login', ?), ('t_new', 'b@x', 'login', ?)",
      ).bind(now - RETENTION_MS.emailTokens - 1, now + 60_000),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES
           ('se_expired', ?, 0, ?, NULL), ('se_revoked', ?, 0, ?, ?), ('se_live', ?, 0, ?, NULL)`,
      ).bind(
        USERS.member1.id,
        now - RETENTION_MS.sessions - 1,
        USERS.member1.id,
        now + DAY_MS,
        now - RETENTION_MS.sessions - 1,
        USERS.member1.id,
        now + DAY_MS,
      ),
    ]);

    const result = await runSweeps(env, now);
    expect(result).toMatchObject({ invites: 3, emailTokens: 1, sessions: 2, failed: [] });
    const ids = async (table: string, col = 'id') =>
      (
        await env.DB.prepare(`SELECT ${col} AS id FROM ${table} ORDER BY 1`).all<{ id: string }>()
      ).results.map((r) => r.id);
    expect(await ids('invites')).toEqual(['i_expired_recent', 'i_usable']);
    expect(await ids('email_tokens', 'token_hash')).toEqual(['t_new']);
    expect(await ids('sessions')).toEqual(['se_live']);
    expect(await runSweeps(env, now)).toMatchObject({ invites: 0, emailTokens: 0, sessions: 0 });
  });

  it('removes thumbnails whose stream is gone, keeps live and recent ones', async () => {
    quiet();
    await roomStub('r_thumbs').upsertStream(testStream('st_live', 4));
    const put = (streamId: string, roomId: string) =>
      env.THUMBNAILS.put(thumbnailKey(streamId), new Uint8Array([0xff, 0xd8, 0xff]), {
        customMetadata: { roomId, streamId },
      });
    await put('st_live', 'r_thumbs');
    await put('st_gone', 'r_thumbs');
    await put('st_noroom', 'r_never_used');
    await env.THUMBNAILS.put('thumbnails/not-a-thumbnail.txt', 'x');

    // Too recent to judge: nothing goes.
    expect((await runSweeps(env, Date.now())).thumbnails).toBe(0);
    const later = Date.now() + THUMBNAIL_MIN_AGE_MS + 1000;
    expect((await runSweeps(env, later)).thumbnails).toBe(3);
    const left = await env.THUMBNAILS.list({ prefix: 'thumbnails/' });
    expect(left.objects.map((o) => o.key)).toEqual([thumbnailKey('st_live')]);
    expect((await runSweeps(env, later)).thumbnails).toBe(0);
  });

  it('is bounded per run', async () => {
    quiet();
    const now = Date.now();
    const n = SWEEP_LIMITS.rows + 5;
    const stmts = Array.from({ length: n }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO email_tokens (token_hash, email, purpose, expires_at) VALUES (?, 'c@x', 'login', 0)",
      ).bind(`bulk_${i}`),
    );
    await env.DB.batch(stmts);
    expect((await runSweeps(env, now)).emailTokens).toBe(SWEEP_LIMITS.rows);
    expect((await runSweeps(env, now)).emailTokens).toBe(5);
  });
});
