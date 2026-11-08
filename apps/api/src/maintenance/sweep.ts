// SPDX-License-Identifier: AGPL-3.0-only
// The housekeeping cron: expired quick rooms are archived and their
// RoomDO closed, invites, e-mail tokens and sessions that can no longer be used are deleted after
// a retention period, and stream thumbnails left in R2 by a stream that is gone are removed.
// Every step is idempotent and bounded per run (a backlog drains over the next runs), runs on its
// own (one failing does not stop the others) and is logged in one line.

import { RoomCloseReason } from '@openlive/protocol';
import { closeRooms } from '../api/sync';
import { isBreakerOpenError } from '../do/breaker';
import { streamIdOfKey, THUMBNAIL_PREFIX } from '../room/thumbnails';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SWEEP_LIMITS = {
  /** Quick rooms archived per run (each one is also a RoomDO call). */
  rooms: 50,
  /** Rows deleted per table per run. */
  rows: 500,
  /** R2 objects listed per run (pages of 100). */
  thumbnails: 300,
} as const;

/** How long rows that can no longer be used are kept, so their pages can still say why. */
export const RETENTION_MS = {
  /** An expired, revoked or used-up invite still answers invite_expired and the like. */
  invites: 7 * DAY_MS,
  emailTokens: DAY_MS,
  sessions: DAY_MS,
} as const;

/** A thumbnail this recent is never swept: its stream may still be announcing or uploading. */
export const THUMBNAIL_MIN_AGE_MS = 2 * 60_000;

export interface SweepResult {
  rooms: number;
  invites: number;
  emailTokens: number;
  sessions: number;
  thumbnails: number;
  failed: string[];
}

async function deleteRows(db: D1Database, table: string, where: string, ...binds: unknown[]) {
  const res = await db
    .prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
    )
    .bind(...binds, SWEEP_LIMITS.rows)
    .run();
  return res.meta.changes;
}

/** Quick rooms past their expiry that are still open: archived, then closed for everyone. */
export async function sweepQuickRooms(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM rooms
     WHERE kind = 'quick' AND archived_at IS NULL AND expires_at <= ?
     ORDER BY expires_at LIMIT ?`,
  )
    .bind(now, SWEEP_LIMITS.rooms)
    .all<{ id: string }>();
  const archived: string[] = [];
  for (const { id } of results) {
    const res = await env.DB.prepare(
      'UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
    )
      .bind(now, id)
      .run();
    if (res.meta.changes > 0) archived.push(id);
  }
  // The RoomDO usually closed itself at expiry already (its alarm); closing again is harmless.
  await closeRooms(env, archived, RoomCloseReason.Expired);
  return archived.length;
}

export function sweepInvites(db: D1Database, now: number): Promise<number> {
  const before = now - RETENTION_MS.invites;
  return deleteRows(
    db,
    'invites',
    `expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
     OR (uses >= max_uses AND created_at <= ?)`,
    before,
    before,
    before,
  );
}

export function sweepEmailTokens(db: D1Database, now: number): Promise<number> {
  return deleteRows(db, 'email_tokens', 'expires_at <= ?', now - RETENTION_MS.emailTokens);
}

export function sweepSessions(db: D1Database, now: number): Promise<number> {
  const before = now - RETENTION_MS.sessions;
  return deleteRows(
    db,
    'sessions',
    'expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)',
    before,
    before,
  );
}

/**
 * Thumbnails whose stream is no longer live in its room (the RoomDO deletes them when a stream
 * ends; this catches a delete that failed or a room that was wiped).
 */
export async function sweepThumbnails(env: Env, now: number): Promise<number> {
  const stale: { key: string; streamId: string | null; roomId: string | undefined }[] = [];
  let cursor: string | undefined;
  let listed = 0;
  do {
    const page = await env.THUMBNAILS.list({
      prefix: THUMBNAIL_PREFIX,
      limit: 100,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    for (const o of page.objects) {
      if (now - o.uploaded.getTime() < THUMBNAIL_MIN_AGE_MS) continue;
      stale.push({
        key: o.key,
        streamId: streamIdOfKey(o.key),
        roomId: o.customMetadata?.['roomId'],
      });
    }
    listed += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && listed < SWEEP_LIMITS.thumbnails);

  const live = new Map<string, Set<string>>();
  /** Rooms whose circuit breaker is open: their thumbnails wait for the next sweep. */
  const unknown = new Set<string>();
  for (const roomId of new Set(stale.flatMap((s) => (s.roomId ? [s.roomId] : [])))) {
    const room = env.ROOM.get(env.ROOM.idFromName(roomId));
    try {
      live.set(roomId, new Set(await room.liveStreamIds()));
    } catch (error) {
      if (!isBreakerOpenError(error)) throw error;
      unknown.add(roomId);
    }
  }
  const orphans = stale
    .filter((s) => !s.roomId || !unknown.has(s.roomId))
    .filter((s) => !s.streamId || !s.roomId || !live.get(s.roomId)?.has(s.streamId))
    .map((s) => s.key);
  if (orphans.length > 0) await env.THUMBNAILS.delete(orphans);
  return orphans.length;
}

export async function runSweeps(env: Env, now: number): Promise<SweepResult> {
  const result: SweepResult = {
    rooms: 0,
    invites: 0,
    emailTokens: 0,
    sessions: 0,
    thumbnails: 0,
    failed: [],
  };
  const steps: [keyof Omit<SweepResult, 'failed'>, () => Promise<number>][] = [
    ['rooms', () => sweepQuickRooms(env, now)],
    ['invites', () => sweepInvites(env.DB, now)],
    ['emailTokens', () => sweepEmailTokens(env.DB, now)],
    ['sessions', () => sweepSessions(env.DB, now)],
    ['thumbnails', () => sweepThumbnails(env, now)],
  ];
  for (const [name, step] of steps) {
    try {
      result[name] = await step();
    } catch (err) {
      result.failed.push(name);
      console.error(`sweep: ${name} failed`, err);
    }
  }
  // Only a run that removed something gets a line: an idle instance's 96 runs a day would
  // otherwise be 96 Workers Logs events of zeros.
  const removed = steps.some(([name]) => result[name] > 0);
  if (removed || result.failed.length) {
    const counts = steps.map(([name]) => `${name}=${result[name]}`).join(' ');
    console.log(
      `sweep: ${counts}${result.failed.length ? ` failed=${result.failed.join(',')}` : ''}`,
    );
  }
  return result;
}
