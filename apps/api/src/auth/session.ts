// SPDX-License-Identifier: AGPL-3.0-only
import { randomToken, sha256Hex } from '../db/util';
import { hmacHex } from './crypto';

// Sessions: the cookie holds a random token; D1 holds only its SHA-256 as the
// session id, so a database leak gives no usable cookie. Revocable, 30 days, sliding, and rotated
// on every renewal: the renewed session gets a new token and id, so a stolen cookie stops working
// once its owner's browser has renewed it.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session is renewed at most once a day, so busy pages do not write to D1 on every call. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long a rotated-out token keeps working, for requests already in flight with it. */
export const ROTATION_GRACE_MS = 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  /** Set when the session was renewed during this request: the new cookie value to send. */
  rotatedToken?: string;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** HMAC of the client IP keyed with SESSION_SECRET: lets abuse be grouped without storing IPs. */
export async function ipHash(request: Request, env: Env): Promise<string | null> {
  const ip = request.headers.get('CF-Connecting-IP');
  return env.SESSION_SECRET && ip ? hmacHex(env.SESSION_SECRET, `ip:${ip}`) : null;
}

export async function createSession(
  request: Request,
  env: Env,
  userId: string,
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const sessionId = await sha256Hex(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip_hash,
                             legacy_cookie)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      sessionId,
      userId,
      now,
      now + SESSION_TTL_MS,
      request.headers.get('User-Agent')?.slice(0, 256) ?? null,
      await ipHash(request, env),
    ),
    env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId),
  ]);
  return { token, sessionId };
}

/**
 * The live session a cookie token names, or null if absent or dead. With `renew`, a session due
 * for renewal is rotated: copied to a new id with a fresh expiry, while the old row points to it
 * and expires after ROTATION_GRACE_MS. Only callers that can set the new cookie pass `renew` (the
 * REST API, not the room socket).
 *
 * `legacy`: the token came under the cookie name used before the __Host- prefix (cookies.ts).
 * Only a session issued back then is accepted that way, and with `renew` it is rotated at once,
 * so its new token is only ever sent under the new name.
 */
export async function resolveSessionToken(
  db: D1Database,
  token: string | null,
  options: { renew?: boolean; legacy?: boolean } = {},
): Promise<ResolvedSession | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const sessionId = await sha256Hex(token);
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT s.user_id, s.expires_at, s.replaced_by FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.deleted_at IS NULL
         AND u.banned_at IS NULL AND (? = 0 OR s.legacy_cookie = 1)`,
    )
    .bind(sessionId, now, options.legacy ? 1 : 0)
    .first<{ user_id: string; expires_at: number; replaced_by: string | null }>();
  if (!row) return null;
  const session = { sessionId, userId: row.user_id };
  const due = options.legacy || row.expires_at - now < SESSION_TTL_MS - RENEW_AFTER_MS;
  if (!options.renew || !due || row.replaced_by !== null) return session;

  const rotatedToken = randomToken();
  const newId = await sha256Hex(rotatedToken);
  // Copy, then retire the old row, in one transaction. Both are conditional on the old row not
  // being replaced yet, so two requests renewing at once cannot fork the session.
  const [copy] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip_hash,
                               legacy_cookie)
         SELECT ?1, user_id, created_at, ?2, user_agent, ip_hash, 0 FROM sessions
         WHERE id = ?3 AND replaced_by IS NULL AND revoked_at IS NULL`,
      )
      .bind(newId, now + SESSION_TTL_MS, sessionId),
    db
      .prepare(
        `UPDATE sessions SET replaced_by = ?1, expires_at = min(expires_at, ?2)
         WHERE id = ?3 AND replaced_by IS NULL AND revoked_at IS NULL`,
      )
      .bind(newId, now + ROTATION_GRACE_MS, sessionId),
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, row.user_id),
  ]);
  if (!copy?.meta.changes) return session;
  return { sessionId: newId, userId: row.user_id, rotatedToken };
}

export async function revokeSession(db: D1Database, userId: string, sessionId: string) {
  const res = await db
    .prepare(
      // A rotation pair ends together: the predecessor still in its grace minute, or the
      // successor of a rotated-out id.
      `UPDATE sessions SET revoked_at = ?1
       WHERE (id = ?2 OR replaced_by = ?2 OR id = (SELECT replaced_by FROM sessions WHERE id = ?2))
         AND user_id = ?3 AND revoked_at IS NULL`,
    )
    .bind(Date.now(), sessionId, userId)
    .run();
  return res.meta.changes > 0;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string | null;
}

export async function listSessions(db: D1Database, userId: string): Promise<SessionInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, created_at, expires_at, user_agent FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND replaced_by IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .bind(userId, Date.now())
    .all<{ id: string; created_at: number; expires_at: number; user_agent: string | null }>();
  return results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
  }));
}
