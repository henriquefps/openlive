// SPDX-License-Identifier: AGPL-3.0-only
// Sliding-window counters in D1 (auth_rate_events) for login abuse: e-mail sends per address and
// per IP, install-code attempts per user. Buckets hold HMACs, never the address or IP.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * How many of each thing one person may create per hour (L4).
 * Far above what a group of friends does, but low enough that someone looping on them cannot
 * spend the D1 and Durable Object free-tier budgets (src/usage/free-tier.ts): a full day at the
 * limit is a few thousand rows.
 */
export const CREATE_PER_HOUR = {
  space: 10,
  /** Fixed and quick rooms together. */
  room: 30,
  invite: 30,
  /** Accepting invites, which files a join request when the invite needs approval. */
  inviteAccept: 30,
} as const;

export type CreateKind = keyof typeof CREATE_PER_HOUR;

/** The per-user hourly limit on creating one kind of thing. */
export const createLimit = (kind: CreateKind, userId: string): Limit => ({
  bucket: `create:${kind}:${userId}`,
  max: CREATE_PER_HOUR[kind],
  windowMs: HOUR_MS,
});

export interface Limit {
  bucket: string;
  max: number;
  windowMs: number;
}

/** How long until every limit has room again, or 0 when none is reached. Records nothing. */
export async function retryAfter(db: D1Database, limits: Limit[], now: number): Promise<number> {
  let wait = 0;
  for (const { bucket, max, windowMs } of limits) {
    const { results } = await db
      .prepare(
        `SELECT created_at FROM auth_rate_events WHERE bucket = ? AND created_at > ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(bucket, now - windowMs, max)
      .all<{ created_at: number }>();
    const oldest = results[max - 1];
    if (oldest) wait = Math.max(wait, oldest.created_at + windowMs - now);
  }
  return wait;
}

/** Counts one attempt in each bucket, and drops rows no window still needs. */
export async function record(db: D1Database, buckets: string[], now: number): Promise<void> {
  await db.batch([
    ...buckets.map((bucket) =>
      db
        .prepare('INSERT INTO auth_rate_events (bucket, created_at) VALUES (?, ?)')
        .bind(bucket, now),
    ),
    db.prepare('DELETE FROM auth_rate_events WHERE created_at < ?').bind(now - DAY_MS),
  ]);
}

/**
 * Checks every limit and, only if none is reached, counts one attempt in each bucket: one INSERT
 * statement, so concurrent requests cannot all pass the check before any of them is counted.
 * Returns 0 when the attempt was counted, else how long until there is room again.
 */
export async function consume(db: D1Database, limits: Limit[], now: number): Promise<number> {
  if (limits.length === 0) return 0;
  const values = limits.map((_, i) => `(?${i * 3 + 2}, ?${i * 3 + 3}, ?${i * 3 + 4})`).join(', ');
  const params = limits.flatMap((l) => [l.bucket, l.max, now - l.windowMs]);
  const res = await db
    .prepare(
      `INSERT INTO auth_rate_events (bucket, created_at)
       WITH lim (bucket, max, since) AS (VALUES ${values})
       SELECT bucket, ?1 FROM lim
       WHERE NOT EXISTS (
         SELECT 1 FROM lim l
         WHERE (SELECT COUNT(*) FROM auth_rate_events e
                WHERE e.bucket = l.bucket AND e.created_at > l.since) >= l.max
       )`,
    )
    .bind(now, ...params)
    .run();
  if (res.meta.changes > 0) {
    await db
      .prepare('DELETE FROM auth_rate_events WHERE created_at < ?')
      .bind(now - DAY_MS)
      .run();
    return 0;
  }
  // Refused: a full window always has an oldest event, so the wait is positive.
  return Math.max(1, await retryAfter(db, limits, now));
}
