// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomCapabilities, RoomKind, RoomVisibility } from '@openlive/protocol';
import type { RoomGrant, RoomRef } from '../auth/can';
import { parseCapabilities, STREAM_ONLY } from '../room/capabilities';
import { parseJsonObject } from './util';

// rooms and room_access. room_access has no space_id column, so its queries join rooms and filter
// on rooms.space_id.

export interface Room {
  id: string;
  spaceId: string;
  kind: RoomKind;
  name: string;
  slug: string;
  /** A quick room's join code (OL-1234-5678); null for fixed rooms. */
  code: string | null;
  visibility: RoomVisibility;
  settings: Record<string, unknown>;
  createdBy: string | null;
  createdAt: number;
  lastActiveAt: number | null;
  expiresAt: number | null;
  archivedAt: number | null;
}

/** A room plus the actor's room_access row, which can() needs. */
export interface RoomForActor extends Room {
  actorAccess: RoomGrant | null;
}

export interface Access {
  userId: string;
  canView: boolean;
  canStream: boolean;
  grantedBy: string | null;
  grantedAt: number;
  expiresAt: number | null;
}

interface RoomRow {
  id: string;
  space_id: string;
  kind: RoomKind;
  name: string;
  slug: string;
  code: string | null;
  visibility: RoomVisibility;
  settings_json: string;
  created_by: string | null;
  created_at: number;
  last_active_at: number | null;
  expires_at: number | null;
  archived_at: number | null;
}

interface AccessColumns {
  can_view: number | null;
  can_stream: number | null;
  access_expires_at: number | null;
}

interface AccessRow {
  user_id: string;
  can_view: number;
  can_stream: number;
  granted_by: string | null;
  granted_at: number;
  expires_at: number | null;
}

const toRoom = (r: RoomRow): Room => ({
  id: r.id,
  spaceId: r.space_id,
  kind: r.kind,
  name: r.name,
  slug: r.slug,
  code: r.code,
  visibility: r.visibility,
  settings: parseJsonObject(r.settings_json),
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
  expiresAt: r.expires_at,
  archivedAt: r.archived_at,
});

const toRoomForActor = (r: RoomRow & AccessColumns): RoomForActor => ({
  ...toRoom(r),
  actorAccess:
    r.can_view === null
      ? null
      : {
          canView: r.can_view === 1,
          canStream: r.can_stream === 1,
          expiresAt: r.access_expires_at,
        },
});

const toAccess = (r: AccessRow): Access => ({
  userId: r.user_id,
  canView: r.can_view === 1,
  canStream: r.can_stream === 1,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
});

/**
 * The fields of a room that can() reads. Its capabilities are the room's own, not reduced by the
 * space and the platform: callers that gate on them use roomAccess (room/access.ts).
 */
export const roomRef = (room: RoomForActor): RoomRef => ({
  id: room.id,
  spaceId: room.spaceId,
  visibility: room.visibility,
  archivedAt: room.archivedAt,
  expiresAt: room.expiresAt,
  actorAccess: room.actorAccess,
  capabilities: roomCapabilities(room.settings),
});

const ROOM_SELECT = `
SELECT r.id, r.space_id, r.kind, r.name, r.slug, r.code, r.visibility, r.settings_json,
       r.created_by, r.created_at, r.last_active_at, r.expires_at, r.archived_at,
       a.can_view, a.can_stream, a.expires_at AS access_expires_at
FROM rooms r
JOIN spaces s ON s.id = r.space_id AND s.deleted_at IS NULL
LEFT JOIN room_access a ON a.room_id = r.id AND a.user_id = ?1`;

/**
 * A room by id, with `userId`'s room_access row. This is the entry point of the /api/rooms/:id
 * routes: the room's space_id comes from here, and every later query filters on it.
 */
export async function getRoomForActor(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<RoomForActor | null> {
  const row = await db
    .prepare(`${ROOM_SELECT} WHERE r.id = ?2`)
    .bind(userId, roomId)
    .first<RoomRow & AccessColumns>();
  return row ? toRoomForActor(row) : null;
}

/**
 * The newest room holding `code` (canonical form), with `userId`'s room_access row. Archived and
 * expired rooms are returned too, so the caller can tell a closed room from a wrong code.
 */
export async function getRoomByCode(
  db: D1Database,
  code: string,
  userId: string,
): Promise<RoomForActor | null> {
  const row = await db
    .prepare(`${ROOM_SELECT} WHERE r.code = ?2 ORDER BY r.created_at DESC LIMIT 1`)
    .bind(userId, code)
    .first<RoomRow & AccessColumns>();
  return row ? toRoomForActor(row) : null;
}

/** The space's open rooms (not archived), with `userId`'s room_access rows. */
export async function listRoomsForActor(
  db: D1Database,
  spaceId: string,
  userId: string,
): Promise<RoomForActor[]> {
  const { results } = await db
    .prepare(`${ROOM_SELECT} WHERE r.space_id = ?2 AND r.archived_at IS NULL ORDER BY r.created_at`)
    .bind(userId, spaceId)
    .all<RoomRow & AccessColumns>();
  return results.map(toRoomForActor);
}

/** Ids of the space's rooms that may have open sockets (not archived, not expired). */
/** A room's own capabilities (settings_json): stream-only when it stored none (migration 0010). */
export const roomCapabilities = (settings: Record<string, unknown>): RoomCapabilities =>
  parseCapabilities(settings['capabilities']) ?? STREAM_ONLY;

export async function openRoomIds(db: D1Database, spaceId: string, now: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM rooms WHERE space_id = ? AND archived_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(spaceId, now)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Every open room of the instance, in spaces that are not deleted. */
export async function allOpenRoomIds(db: D1Database, now: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM rooms r JOIN spaces s ON s.id = r.space_id AND s.deleted_at IS NULL
       WHERE r.archived_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ?)`,
    )
    .bind(now)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export function insertRoomStatement(
  db: D1Database,
  room: Omit<Room, 'lastActiveAt' | 'archivedAt'>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rooms (id, space_id, kind, name, slug, code, visibility, settings_json,
                          created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      room.id,
      room.spaceId,
      room.kind,
      room.name,
      room.slug,
      room.code,
      room.visibility,
      JSON.stringify(room.settings),
      room.createdBy,
      room.createdAt,
      room.expiresAt,
    );
}

export function updateRoomStatement(
  db: D1Database,
  spaceId: string,
  roomId: string,
  fields: Pick<Room, 'name' | 'slug' | 'visibility' | 'settings'>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rooms SET name = ?, slug = ?, visibility = ?, settings_json = ?
       WHERE id = ? AND space_id = ?`,
    )
    .bind(
      fields.name,
      fields.slug,
      fields.visibility,
      JSON.stringify(fields.settings),
      roomId,
      spaceId,
    );
}

export function archiveRoomStatement(
  db: D1Database,
  spaceId: string,
  roomId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE rooms SET archived_at = ? WHERE id = ? AND space_id = ? AND archived_at IS NULL',
    )
    .bind(now, roomId, spaceId);
}

// --- room_access ---

const ACCESS_SELECT = `
SELECT a.user_id, a.can_view, a.can_stream, a.granted_by, a.granted_at, a.expires_at
FROM room_access a JOIN rooms r ON r.id = a.room_id`;

export async function getAccess(
  db: D1Database,
  spaceId: string,
  roomId: string,
  userId: string,
): Promise<Access | null> {
  const row = await db
    .prepare(`${ACCESS_SELECT} WHERE r.space_id = ? AND a.room_id = ? AND a.user_id = ?`)
    .bind(spaceId, roomId, userId)
    .first<AccessRow>();
  return row ? toAccess(row) : null;
}

export async function listAccess(
  db: D1Database,
  spaceId: string,
  roomId: string,
): Promise<Access[]> {
  const { results } = await db
    .prepare(`${ACCESS_SELECT} WHERE r.space_id = ? AND a.room_id = ? ORDER BY a.granted_at`)
    .bind(spaceId, roomId)
    .all<AccessRow>();
  return results.map(toAccess);
}

/** Inserts or replaces a grant, keeping the room inside `spaceId`. */
export function upsertAccessStatement(
  db: D1Database,
  spaceId: string,
  roomId: string,
  access: Access,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO room_access (room_id, user_id, can_view, can_stream, granted_by, granted_at,
                                expires_at)
       SELECT id, ?, ?, ?, ?, ?, ? FROM rooms WHERE id = ? AND space_id = ?
       ON CONFLICT (room_id, user_id) DO UPDATE SET can_view = excluded.can_view,
         can_stream = excluded.can_stream, granted_by = excluded.granted_by,
         granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
    )
    .bind(
      access.userId,
      access.canView ? 1 : 0,
      access.canStream ? 1 : 0,
      access.grantedBy,
      access.grantedAt,
      access.expiresAt,
      roomId,
      spaceId,
    );
}

export function deleteAccessStatement(
  db: D1Database,
  spaceId: string,
  roomId: string,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM room_access WHERE user_id = ? AND room_id = ?
       AND room_id IN (SELECT id FROM rooms WHERE space_id = ?)`,
    )
    .bind(userId, roomId, spaceId);
}

/** Drops every grant `userId` holds in the space's rooms (they left or were removed). */
export function deleteAllAccessStatement(
  db: D1Database,
  spaceId: string,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare(
      'DELETE FROM room_access WHERE user_id = ? AND room_id IN (SELECT id FROM rooms WHERE space_id = ?)',
    )
    .bind(userId, spaceId);
}
