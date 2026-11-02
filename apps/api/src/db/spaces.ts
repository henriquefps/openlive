// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@openlive/protocol';
import { parseJsonObject } from './util';

// spaces and space_members. Every query names the space it reads or writes.

export interface Space {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  plan: string;
  /** The space's own settings_json (only the levels it overrides; see api/settings.ts). */
  settings: Record<string, unknown>;
  createdAt: number;
  /** Set while the platform admin keeps the space suspended. */
  suspendedAt: number | null;
}

export interface Member {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  invitedBy: string | null;
  joinedAt: number;
  bannedAt: number | null;
}

interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  plan: string;
  settings_json: string;
  created_at: number;
  suspended_at: number | null;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: Role;
  invited_by: string | null;
  joined_at: number;
  banned_at: number | null;
}

const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  ownerId: r.owner_id,
  plan: r.plan,
  settings: parseJsonObject(r.settings_json),
  createdAt: r.created_at,
  suspendedAt: r.suspended_at,
});

const toMember = (r: MemberRow): Member => ({
  userId: r.user_id,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  role: r.role,
  invitedBy: r.invited_by,
  joinedAt: r.joined_at,
  bannedAt: r.banned_at,
});

const SPACE_COLUMNS = 'id, name, slug, owner_id, plan, settings_json, created_at, suspended_at';

export async function getSpace(db: D1Database, spaceId: string): Promise<Space | null> {
  const row = await db
    .prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ? AND deleted_at IS NULL`)
    .bind(spaceId)
    .first<SpaceRow>();
  return row ? toSpace(row) : null;
}

/** The spaces `userId` belongs to (not banned), with their role in each. */
export async function listSpacesOf(
  db: D1Database,
  userId: string,
): Promise<(Space & { role: Role })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.slug, s.owner_id, s.plan, s.settings_json, s.created_at,
              s.suspended_at, m.role
       FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
       WHERE m.user_id = ? AND m.banned_at IS NULL
       ORDER BY s.created_at`,
    )
    .bind(userId)
    .all<SpaceRow & { role: Role }>();
  return results.map((r) => ({ ...toSpace(r), role: r.role }));
}

export function insertSpaceStatements(
  db: D1Database,
  space: { id: string; name: string; slug: string; ownerId: string },
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare('INSERT INTO spaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(space.id, space.name, space.slug, space.ownerId, now),
    insertMemberStatement(db, space.id, space.ownerId, 'owner', null, now),
  ];
}

export function updateSpaceStatement(
  db: D1Database,
  spaceId: string,
  fields: { name: string; settings: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare('UPDATE spaces SET name = ?, settings_json = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(fields.name, JSON.stringify(fields.settings), spaceId);
}

export function deleteSpaceStatement(
  db: D1Database,
  spaceId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare('UPDATE spaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(now, spaceId);
}

/** Demote the owner first: the one-owner index is checked after every statement. */
export function transferStatements(
  db: D1Database,
  spaceId: string,
  fromUserId: string,
  toUserId: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE space_members SET role = 'admin' WHERE space_id = ? AND user_id = ?")
      .bind(spaceId, fromUserId),
    db
      .prepare("UPDATE space_members SET role = 'owner' WHERE space_id = ? AND user_id = ?")
      .bind(spaceId, toUserId),
    db.prepare('UPDATE spaces SET owner_id = ? WHERE id = ?').bind(toUserId, spaceId),
  ];
}

// --- Members ---

const MEMBER_SELECT = `
SELECT m.user_id, u.display_name, u.avatar_url, m.role, m.invited_by, m.joined_at, m.banned_at
FROM space_members m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL`;

export async function getMember(
  db: D1Database,
  spaceId: string,
  userId: string,
): Promise<Member | null> {
  const row = await db
    .prepare(`${MEMBER_SELECT} WHERE m.space_id = ? AND m.user_id = ?`)
    .bind(spaceId, userId)
    .first<MemberRow>();
  return row ? toMember(row) : null;
}

export async function listMembers(
  db: D1Database,
  spaceId: string,
  includeBanned: boolean,
): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `${MEMBER_SELECT} WHERE m.space_id = ?1 AND (?2 = 1 OR m.banned_at IS NULL)
       ORDER BY m.joined_at, m.user_id`,
    )
    .bind(spaceId, includeBanned ? 1 : 0)
    .all<MemberRow>();
  return results.map(toMember);
}

export function insertMemberStatement(
  db: D1Database,
  spaceId: string,
  userId: string,
  role: Role,
  invitedBy: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO space_members (space_id, user_id, role, invited_by, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spaceId, userId, role, invitedBy, now);
}

export function setRoleStatement(
  db: D1Database,
  spaceId: string,
  userId: string,
  role: Role,
): D1PreparedStatement {
  return db
    .prepare('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ?')
    .bind(role, spaceId, userId);
}

export function setBannedStatement(
  db: D1Database,
  spaceId: string,
  userId: string,
  bannedAt: number | null,
): D1PreparedStatement {
  return db
    .prepare('UPDATE space_members SET banned_at = ? WHERE space_id = ? AND user_id = ?')
    .bind(bannedAt, spaceId, userId);
}

export function deleteMemberStatement(
  db: D1Database,
  spaceId: string,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?')
    .bind(spaceId, userId);
}
