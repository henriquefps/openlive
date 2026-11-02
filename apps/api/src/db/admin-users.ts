// SPDX-License-Identifier: AGPL-3.0-only
import type { Provider } from '../auth/accounts';
import type { SpaceRole } from '../auth/can';
import { SESSION_TTL_MS } from '../auth/session';
import { parseJsonObject } from './util';

// Platform user management: every account, the spaces it belongs to, its sessions,
// devices and recent activity. The platform admin sees account metadata only: never stream
// content, and never IP addresses (sessions keep only an HMAC of the IP, which is not returned).

export const USER_FILTERS = ['all', 'no_space', 'banned', 'admins'] as const;
export type UserFilter = (typeof USER_FILTERS)[number];

/** Rows per page of the list. */
export const USER_PAGE_SIZE = 50;

export interface UserSpace {
  id: string;
  name: string;
  slug: string;
  role: SpaceRole;
  /** Set when the space banned the account (space-level ban). */
  bannedAt: number | null;
}

export interface AdminUserSummary {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  primaryEmail: string | null;
  providers: Provider[];
  isPlatformAdmin: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Set while the account is banned from the whole instance. */
  bannedAt: number | null;
  deviceCount: number;
  spaces: UserSpace[];
}

// An account counts as in no space when it is in no live space, holds no active room grant and has
// no pending join request (accounts created before sign-up became invite-only).
const NO_SPACE = `
NOT EXISTS (
  SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
  WHERE m.user_id = u.id)
AND NOT EXISTS (
  SELECT 1 FROM room_access a
  JOIN rooms r ON r.id = a.room_id
  JOIN spaces s ON s.id = r.space_id AND s.deleted_at IS NULL
  WHERE a.user_id = u.id AND a.can_view = 1 AND r.archived_at IS NULL
    AND (a.expires_at IS NULL OR a.expires_at > ?1)
    AND (r.expires_at IS NULL OR r.expires_at > ?1))
AND NOT EXISTS (
  SELECT 1 FROM join_requests j WHERE j.user_id = u.id AND j.status = 'pending')`;

const FILTER_SQL: Record<UserFilter, string> = {
  all: '1',
  no_space: `u.is_platform_admin = 0 AND ${NO_SPACE}`,
  banned: 'u.banned_at IS NOT NULL',
  admins: 'u.is_platform_admin = 1',
};

const SUMMARY_COLUMNS = `
u.id, u.display_name, u.avatar_url, u.primary_email, u.is_platform_admin, u.created_at,
u.last_seen_at, u.banned_at,
(SELECT group_concat(provider, ',') FROM
  (SELECT DISTINCT provider FROM identities i WHERE i.user_id = u.id ORDER BY provider)
) AS providers,
(SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices`;

interface SummaryRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  primary_email: string | null;
  is_platform_admin: number;
  created_at: number;
  last_seen_at: number | null;
  banned_at: number | null;
  providers: string | null;
  devices: number;
}

/** A position in the list (newest first): the last row's creation time and id. */
export interface UserCursor {
  createdAt: number;
  id: string;
}

export const encodeCursor = (c: UserCursor): string => `${c.createdAt}.${c.id}`;

export function decodeCursor(value: string | undefined): UserCursor | null {
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/.exec(value ?? '');
  return m?.[1] && m[2] ? { createdAt: Number(m[1]), id: m[2] } : null;
}

/** `%` and `_` match themselves in the search. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

async function spacesOf(db: D1Database, userIds: string[]): Promise<Map<string, UserSpace[]>> {
  const out = new Map<string, UserSpace[]>();
  if (userIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT m.user_id, s.id, s.name, s.slug, m.role, m.banned_at
       FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
       WHERE m.user_id IN (${userIds.map(() => '?').join(', ')})
       ORDER BY s.name, s.id`,
    )
    .bind(...userIds)
    .all<{
      user_id: string;
      id: string;
      name: string;
      slug: string;
      role: SpaceRole;
      banned_at: number | null;
    }>();
  for (const r of results) {
    const list = out.get(r.user_id) ?? [];
    list.push({ id: r.id, name: r.name, slug: r.slug, role: r.role, bannedAt: r.banned_at });
    out.set(r.user_id, list);
  }
  return out;
}

function summary(row: SummaryRow, spaces: UserSpace[]): AdminUserSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    primaryEmail: row.primary_email,
    providers: row.providers ? (row.providers.split(',') as Provider[]) : [],
    isPlatformAdmin: row.is_platform_admin === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    bannedAt: row.banned_at,
    deviceCount: row.devices,
    spaces,
  };
}

/**
 * One page of live accounts, newest first. `query` matches the display name or e-mail
 * (case-insensitive, anywhere) or the exact id.
 */
export async function listUsers(
  db: D1Database,
  opts: { query: string; filter: UserFilter; cursor: UserCursor | null },
  now: number,
): Promise<{ users: AdminUserSummary[]; nextCursor: string | null }> {
  const query = opts.query.trim().toLowerCase();
  const like = `%${likeEscape(query)}%`;
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM users u
       WHERE u.deleted_at IS NULL AND ${FILTER_SQL[opts.filter]}
         AND (?2 = '' OR lower(u.display_name) LIKE ?3 ESCAPE '\\'
              OR lower(coalesce(u.primary_email, '')) LIKE ?3 ESCAPE '\\' OR u.id = ?2)
         AND (?4 IS NULL OR u.created_at < ?4 OR (u.created_at = ?4 AND u.id < ?5))
       ORDER BY u.created_at DESC, u.id DESC LIMIT ${USER_PAGE_SIZE + 1}`,
    )
    .bind(now, query, like, opts.cursor?.createdAt ?? null, opts.cursor?.id ?? '')
    .all<SummaryRow>();
  const page = results.slice(0, USER_PAGE_SIZE);
  const spaces = await spacesOf(
    db,
    page.map((r) => r.id),
  );
  const last = page.at(-1);
  return {
    users: page.map((r) => summary(r, spaces.get(r.id) ?? [])),
    nextCursor:
      results.length > USER_PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

/** A live account (banned or not), or null. */
export async function getUserSummary(
  db: D1Database,
  userId: string,
): Promise<(AdminUserSummary & { bannedReason: string | null; bannedBy: string | null }) | null> {
  const row = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, u.banned_reason, u.banned_by FROM users u
       WHERE u.id = ? AND u.deleted_at IS NULL`,
    )
    .bind(userId)
    .first<SummaryRow & { banned_reason: string | null; banned_by: string | null }>();
  if (!row) return null;
  const spaces = await spacesOf(db, [row.id]);
  return {
    ...summary(row, spaces.get(row.id) ?? []),
    bannedReason: row.banned_reason,
    bannedBy: row.banned_by,
  };
}

export interface AdminSession {
  id: string;
  createdAt: number;
  /** When the session was last renewed (it renews at most daily while in use). */
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
}

/** The account's live sessions; no IP or IP hash. */
export async function activeSessions(
  db: D1Database,
  userId: string,
  now: number,
): Promise<AdminSession[]> {
  const { results } = await db
    .prepare(
      `SELECT id, created_at, expires_at, user_agent FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND replaced_by IS NULL AND expires_at > ?
       ORDER BY expires_at DESC`,
    )
    .bind(userId, now)
    .all<{ id: string; created_at: number; expires_at: number; user_agent: string | null }>();
  return results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastSeenAt: Math.max(r.created_at, r.expires_at - SESSION_TTL_MS),
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
  }));
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  spaceId: string | null;
  spaceName: string | null;
  actorId: string | null;
  actorName: string | null;
  target: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

/** Audit entries by the account or about it (as target, or as `userId` in the data). */
export async function recentAudit(
  db: D1Database,
  userId: string,
  limit = 50,
): Promise<AdminAuditEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.action, l.space_id, s.name AS space_name, l.actor_id,
              a.display_name AS actor_name, l.target, l.data_json, l.created_at
       FROM audit_log l
       LEFT JOIN spaces s ON s.id = l.space_id
       LEFT JOIN users a ON a.id = l.actor_id AND a.deleted_at IS NULL
       WHERE l.actor_id = ?1 OR l.target = ?1 OR json_extract(l.data_json, '$.userId') = ?1
       ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{
      id: string;
      action: string;
      space_id: string | null;
      space_name: string | null;
      actor_id: string | null;
      actor_name: string | null;
      target: string | null;
      data_json: string;
      created_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    action: r.action,
    spaceId: r.space_id,
    spaceName: r.space_name,
    actorId: r.actor_id,
    actorName: r.actor_name,
    target: r.target,
    data: parseJsonObject(r.data_json),
    createdAt: r.created_at,
  }));
}

export interface UserRoom {
  id: string;
  name: string;
  spaceId: string;
  spaceName: string;
}

/** The open rooms the account may be in: its spaces' rooms and the rooms it holds a grant to. */
export async function roomsOfUser(
  db: D1Database,
  userId: string,
  now: number,
): Promise<UserRoom[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, s.id AS space_id, s.name AS space_name
       FROM rooms r JOIN spaces s ON s.id = r.space_id AND s.deleted_at IS NULL
       WHERE r.archived_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ?2)
         AND (EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = r.space_id AND m.user_id = ?1)
              OR EXISTS (SELECT 1 FROM room_access a WHERE a.room_id = r.id AND a.user_id = ?1))
       ORDER BY s.name, r.name`,
    )
    .bind(userId, now)
    .all<{ id: string; name: string; space_id: string; space_name: string }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    spaceId: r.space_id,
    spaceName: r.space_name,
  }));
}

/** The rooms whose chat holds the account's messages (migration 0011), archived ones included. */
export async function chatRoomsOf(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT room_id FROM chat_authors WHERE user_id = ? ORDER BY room_id')
    .bind(userId)
    .all<{ room_id: string }>();
  return results.map((r) => r.room_id);
}

/** Live platform admins other than `userId` (banned ones do not count). */
export async function otherAdmins(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE is_platform_admin = 1 AND deleted_at IS NULL AND banned_at IS NULL AND id != ?`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The live spaces the account owns. */
export async function ownedSpaces(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM spaces WHERE owner_id = ? AND deleted_at IS NULL ORDER BY id')
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Every statement that deletes the account's personal data (LGPD), in order. The users
 * row stays as a tombstone with every personal field cleared, so ids elsewhere (deleted spaces,
 * usage) stay valid; nothing left points to a person. Audit rows are kept, anonymized.
 */
export async function deletionStatements(
  db: D1Database,
  userId: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const { results: emails } = await db
    .prepare(
      `SELECT email FROM identities WHERE user_id = ?1 AND email IS NOT NULL
       UNION SELECT primary_email FROM users WHERE id = ?1 AND primary_email IS NOT NULL`,
    )
    .bind(userId)
    .all<{ email: string }>();
  const s = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  return [
    s('DELETE FROM space_members WHERE user_id = ?', userId),
    s('UPDATE space_members SET invited_by = NULL WHERE invited_by = ?', userId),
    s('DELETE FROM room_access WHERE user_id = ?', userId),
    s('UPDATE room_access SET granted_by = NULL WHERE granted_by = ?', userId),
    s('DELETE FROM join_requests WHERE user_id = ?', userId),
    s('UPDATE join_requests SET decided_by = NULL WHERE decided_by = ?', userId),
    s('UPDATE invites SET created_by = NULL WHERE created_by = ?', userId),
    s('UPDATE rooms SET created_by = NULL WHERE created_by = ?', userId),
    s('DELETE FROM sessions WHERE user_id = ?', userId),
    s('DELETE FROM devices WHERE user_id = ?', userId),
    s('DELETE FROM device_codes WHERE approved_by = ?', userId),
    s('DELETE FROM identities WHERE user_id = ?', userId),
    s('DELETE FROM user_tutorial WHERE user_id = ?', userId),
    // The rooms were read before (chatRoomsOf); their RoomDOs erase the messages after the batch.
    s('DELETE FROM chat_authors WHERE user_id = ?', userId),
    ...emails.map((e) => s('DELETE FROM email_tokens WHERE email = ?', e.email)),
    s("DELETE FROM auth_rate_events WHERE substr(bucket, instr(bucket, ':') + 1) = ?", userId),
    s(
      "UPDATE realtime_sessions SET user_id = 'deleted', device_id = NULL WHERE user_id = ?",
      userId,
    ),
    s('UPDATE platform_settings SET updated_by = NULL WHERE updated_by = ?', userId),
    // Audit rows stay (who did what to a space), without the person: names in the data first,
    // then the id wherever it appears.
    s(
      "UPDATE audit_log SET data_json = json_remove(data_json, '$.displayName') WHERE target = ?",
      userId,
    ),
    s('UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?', userId),
    s('UPDATE audit_log SET target = NULL WHERE target = ?', userId),
    s(
      `UPDATE audit_log SET data_json = replace(data_json, ?1, 'deleted')
       WHERE instr(data_json, ?1) > 0`,
      userId,
    ),
    s('UPDATE users SET banned_by = NULL WHERE banned_by = ?', userId),
    s('UPDATE banned_identities SET banned_by = NULL WHERE banned_by = ?', userId),
    // A ban outlives the account: its identities stay banned, no longer linked to it.
    s('UPDATE banned_identities SET user_id = NULL WHERE user_id = ?', userId),
    s(
      `UPDATE users SET display_name = '', avatar_url = NULL, discord_avatar_url = NULL,
         avatar_source = NULL, primary_email = NULL, locale = NULL,
         is_platform_admin = 0, last_seen_at = NULL, banned_reason = NULL, banned_by = NULL,
         deleted_at = ?2
       WHERE id = ?1`,
      userId,
      now,
    ),
  ];
}

/** The tables deletionStatements touches, for the docs and the tests. */
export const DELETION_TABLES = [
  'space_members',
  'room_access',
  'join_requests',
  'invites',
  'rooms',
  'sessions',
  'devices',
  'device_codes',
  'identities',
  'user_tutorial',
  'chat_authors',
  'email_tokens',
  'auth_rate_events',
  'realtime_sessions',
  'platform_settings',
  'audit_log',
  'banned_identities',
  'users',
] as const;
