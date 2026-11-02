// SPDX-License-Identifier: AGPL-3.0-only
import { newId, randomToken, sha256Hex } from '../db/util';
import { pkceChallenge, safeEqual } from './crypto';

// The mobile app's credentials (docs/PROTOCOL.md 11.6), the native-app pattern of
// RFC 8252: the system browser signs in, the person allows the app on /app/authorize, the
// instance redirects to openlive://auth with a one-time code, and the app exchanges the code and
// its PKCE verifier (RFC 7636, S256 only) for an app token. The app then sends the token as
// `Authorization: Bearer`, and opens its sockets with single-use tickets.
//
// Codes, tokens and tickets are stored only as SHA-256 hashes and never reach a log. Tokens and
// tickets carry a prefix, so a bearer is told apart from a helper's device token without a lookup.

/** The one client this instance knows: the Openlive app. */
export const APP_CLIENT = 'openlive-mobile';
/** The only redirect URI, compared exactly: nothing else is ever redirected to. */
export const APP_REDIRECT_URI = 'openlive://auth';

/** How long an authorization code can be exchanged. */
export const APP_CODE_TTL_MS = 2 * 60 * 1000;
/** An app token unused for this long stops working (each use moves the expiry). */
export const APP_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** How long a WebSocket ticket can be used. */
export const WS_TICKET_TTL_MS = 60 * 1000;
/** last_used_at (and the sliding expiry) is written at most this often. */
const LAST_USED_EVERY_MS = 5 * 60 * 1000;

export const APP_TOKEN_PREFIX = 'ola_';
export const WS_TICKET_PREFIX = 'olt_';
const TOKEN_PATTERN = /^ola_[A-Za-z0-9_-]{43}$/;
const TICKET_PATTERN = /^olt_[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether a bearer is an app token (as opposed to a device token). */
export const isAppToken = (bearer: string): boolean => bearer.startsWith(APP_TOKEN_PREFIX);

export interface AppGrant {
  client: string;
  redirectUri: string;
  codeChallenge: string;
  deviceName: string;
}

/** Issues a code for `userId`, who allowed the app on /app/authorize. Returns the code. */
export async function createAppCode(
  db: D1Database,
  userId: string,
  grant: AppGrant,
  now: number,
): Promise<string> {
  const code = randomToken();
  await db.batch([
    db.prepare('DELETE FROM app_codes WHERE expires_at <= ?').bind(now),
    db
      .prepare(
        `INSERT INTO app_codes (code_hash, user_id, client, redirect_uri, code_challenge,
                                device_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(code),
        userId,
        grant.client,
        grant.redirectUri,
        grant.codeChallenge,
        grant.deviceName,
        now,
        now + APP_CODE_TTL_MS,
      ),
  ]);
  return code;
}

export interface NewAppToken {
  token: string;
  tokenId: string;
  userId: string;
}

/**
 * Exchanges a code for an app token. The code is consumed whatever the outcome (single use: a
 * wrong verifier burns it too). Null when the code is unknown, used, expired, or was issued for
 * another client, redirect URI or challenge; the caller answers the same error for all of them.
 */
export async function exchangeAppCode(
  db: D1Database,
  input: { code: string; codeVerifier: string; client: string; redirectUri: string },
  now: number,
): Promise<NewAppToken | null> {
  if (!CODE_PATTERN.test(input.code)) return null;
  const row = await db
    .prepare(
      `DELETE FROM app_codes WHERE code_hash = ?
       RETURNING user_id, client, redirect_uri, code_challenge, device_name, expires_at`,
    )
    .bind(await sha256Hex(input.code))
    .first<{
      user_id: string;
      client: string;
      redirect_uri: string;
      code_challenge: string;
      device_name: string;
      expires_at: number;
    }>();
  if (!row || row.expires_at <= now) return null;
  if (row.client !== input.client || row.redirect_uri !== input.redirectUri) return null;
  if (!(await safeEqual(await pkceChallenge(input.codeVerifier), row.code_challenge))) return null;

  const token = `${APP_TOKEN_PREFIX}${randomToken()}`;
  const tokenId = newId('at');
  // The user may have been banned or deleted in the two minutes since they allowed it.
  const res = await db
    .prepare(
      `INSERT INTO app_tokens (id, user_id, client, device_name, token_hash, created_at,
                               expires_at, last_used_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6 FROM users
       WHERE id = ?2 AND deleted_at IS NULL AND banned_at IS NULL`,
    )
    .bind(
      tokenId,
      row.user_id,
      row.client,
      row.device_name,
      await sha256Hex(token),
      now,
      now + APP_TOKEN_IDLE_MS,
    )
    .run();
  if (!res.meta.changes) return null;
  return { token, tokenId, userId: row.user_id };
}

/** The live app token a bearer names, or null. Slides its expiry now and then. */
export async function resolveAppToken(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ userId: string; appTokenId: string } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT t.id, t.user_id, t.last_used_at FROM app_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
         AND u.deleted_at IS NULL AND u.banned_at IS NULL`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_EVERY_MS) {
    await db
      .prepare('UPDATE app_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?')
      .bind(now, now + APP_TOKEN_IDLE_MS, row.id)
      .run();
  }
  return { userId: row.user_id, appTokenId: row.id };
}

/** A single-use ticket for one socket upgrade by this app token. */
export async function createWsTicket(
  db: D1Database,
  appTokenId: string,
  now: number,
): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = `${WS_TICKET_PREFIX}${randomToken()}`;
  const expiresAt = now + WS_TICKET_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM app_ws_tickets WHERE expires_at <= ?').bind(now),
    db
      .prepare(
        'INSERT INTO app_ws_tickets (ticket_hash, app_token_id, expires_at) VALUES (?, ?, ?)',
      )
      .bind(await sha256Hex(ticket), appTokenId, expiresAt),
  ]);
  return { ticket, expiresAt };
}

/**
 * Consumes a ticket: the identity of its app token, or null when the ticket is unknown, used or
 * expired, or the token was revoked since.
 */
export async function consumeWsTicket(
  db: D1Database,
  ticket: string,
  now: number,
): Promise<{ userId: string; appTokenId: string } | null> {
  if (!TICKET_PATTERN.test(ticket)) return null;
  const used = await db
    .prepare('DELETE FROM app_ws_tickets WHERE ticket_hash = ? RETURNING app_token_id, expires_at')
    .bind(await sha256Hex(ticket))
    .first<{ app_token_id: string; expires_at: number }>();
  if (!used || used.expires_at <= now) return null;
  const row = await db
    .prepare(
      `SELECT t.user_id FROM app_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
         AND u.deleted_at IS NULL AND u.banned_at IS NULL`,
    )
    .bind(used.app_token_id, now)
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id, appTokenId: used.app_token_id } : null;
}

export interface AppTokenInfo {
  id: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The user's live app tokens, for Settings > Sessions. */
export async function listAppTokens(
  db: D1Database,
  userId: string,
  now: number,
): Promise<AppTokenInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, device_name, created_at, last_used_at FROM app_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, id`,
    )
    .bind(userId, now)
    .all<{ id: string; device_name: string; created_at: number; last_used_at: number | null }>();
  return results.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Revokes one of the user's app tokens and its unused tickets; false when not theirs or gone. */
export async function revokeAppToken(
  db: D1Database,
  userId: string,
  appTokenId: string,
  now: number,
): Promise<boolean> {
  const [res] = await db.batch([
    db
      .prepare(
        'UPDATE app_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .bind(now, appTokenId, userId),
    db
      .prepare(
        `DELETE FROM app_ws_tickets WHERE app_token_id = ?
         AND EXISTS (SELECT 1 FROM app_tokens WHERE id = ? AND user_id = ?)`,
      )
      .bind(appTokenId, appTokenId, userId),
  ]);
  return (res?.meta.changes ?? 0) > 0;
}

/** Whether a session id names an app token (Settings > Sessions lists both kinds). */
export const isAppTokenId = (id: string): boolean => id.startsWith('at_');
