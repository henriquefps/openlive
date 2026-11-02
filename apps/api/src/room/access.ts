// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode, Role, RoomKind, RoomSettings, RoomVisibility } from '@openlive/protocol';
import { type Actor, can, type RoomRef } from '../auth/can';
import { CAPABILITIES_KEY, jsonObject, ROOM_LIMITS_KEY, roomLimitsOf } from '../db/platform';
import { ALL_CAPABILITIES, parseCapabilities } from './capabilities';
import { effectiveSettings } from './settings';
import type { ConnectContext } from './types';

interface AccessRow {
  room_id: string;
  space_id: string;
  kind: RoomKind;
  name: string;
  visibility: RoomVisibility;
  room_settings: string;
  expires_at: number | null;
  archived_at: number | null;
  space_settings: string;
  suspended_at: number | null;
  platform_limits: string | null;
  platform_capabilities: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_platform_admin: number | null;
  role: Role | null;
  banned_at: number | null;
  can_view: number | null;
  can_stream: number | null;
  access_expires_at: number | null;
}

// One query: the room and its space, the platform's room ceilings and capabilities, plus the
// caller's user, membership and room_access rows.
const ACCESS_QUERY = `
SELECT r.id AS room_id, r.space_id, r.kind, r.name, r.visibility, r.settings_json AS room_settings,
       r.expires_at, r.archived_at, s.settings_json AS space_settings, s.suspended_at,
       p.value_json AS platform_limits, pc.value_json AS platform_capabilities,
       u.display_name, u.avatar_url, u.is_platform_admin,
       m.role, m.banned_at,
       a.can_view, a.can_stream, a.expires_at AS access_expires_at
FROM rooms r
JOIN spaces s ON s.id = r.space_id AND s.deleted_at IS NULL
LEFT JOIN users u ON u.id = ?2 AND u.deleted_at IS NULL AND u.banned_at IS NULL
LEFT JOIN space_members m ON m.space_id = r.space_id AND m.user_id = ?2
LEFT JOIN room_access a ON a.room_id = r.id AND a.user_id = ?2
LEFT JOIN platform_settings p ON p.key = ?3
LEFT JOIN platform_settings pc ON pc.key = ?4
WHERE r.id = ?1`;

export type AccessResult =
  | { ok: true; context: ConnectContext }
  | { ok: false; status: 401 | 403 | 404 | 410; code: ErrorCode };

/** Loads what can() needs from D1 and decides whether `userId` may enter the room. */
export async function roomAccess(
  db: D1Database,
  roomId: string,
  userId: string,
  now: number = Date.now(),
): Promise<AccessResult> {
  const row = await db
    .prepare(ACCESS_QUERY)
    .bind(roomId, userId, ROOM_LIMITS_KEY, CAPABILITIES_KEY)
    .first<AccessRow>();
  if (!row) return { ok: false, status: 404, code: 'room_not_found' };
  if (row.display_name === null) return { ok: false, status: 401, code: 'unauthenticated' };
  // Nobody enters a suspended space's rooms, the platform admin included (no content, 6.4.3).
  if (row.suspended_at !== null) return { ok: false, status: 403, code: 'space_suspended' };

  const actor: Actor = {
    userId,
    isPlatformAdmin: row.is_platform_admin === 1,
    membership: row.role
      ? { spaceId: row.space_id, role: row.role, bannedAt: row.banned_at }
      : null,
  };
  // The admin's platform ceilings, lowered by the space and the room: the 120 fps
  // presets and a higher bitrate reach the room once the admin allows them. The same holds for the
  // capabilities.
  const settings = settingsOf(row);
  const room: RoomRef = {
    id: row.room_id,
    spaceId: row.space_id,
    visibility: row.visibility,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
    actorAccess:
      row.can_view === null
        ? null
        : {
            canView: row.can_view === 1,
            canStream: row.can_stream === 1,
            expiresAt: row.access_expires_at,
          },
    capabilities: settings.capabilities ?? ALL_CAPABILITIES,
  };
  const view = can(actor, 'room.view', { room }, now);
  if (!view.allowed) {
    return view.code === 'room_closed'
      ? { ok: false, status: 410, code: 'room_closed' }
      : { ok: false, status: 403, code: 'forbidden' };
  }

  // can() allowed the view, so a caller without a membership is a guest of this room only.
  const role: Role = row.role ?? 'guest';
  return {
    ok: true,
    context: {
      userId,
      displayName: row.display_name,
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      role,
      permissions: {
        canStream: can(actor, 'stream.permission', { room }, now).allowed,
        canModerate: role === 'owner' || role === 'admin',
      },
      room: {
        roomId: row.room_id,
        spaceId: row.space_id,
        kind: row.kind,
        visibility: row.visibility,
        name: row.name,
        ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      },
      settings,
    },
  };
}

type SettingsRow = Pick<
  AccessRow,
  'room_settings' | 'space_settings' | 'platform_limits' | 'platform_capabilities'
>;

const settingsOf = (row: SettingsRow): RoomSettings =>
  effectiveSettings(
    row.space_settings,
    row.room_settings,
    roomLimitsOf(
      jsonObject(row.platform_limits),
      parseCapabilities(jsonObject(row.platform_capabilities)) ?? ALL_CAPABILITIES,
    ),
  );

const SETTINGS_QUERY = `
SELECT r.settings_json AS room_settings, s.settings_json AS space_settings,
       p.value_json AS platform_limits, pc.value_json AS platform_capabilities
FROM rooms r
JOIN spaces s ON s.id = r.space_id
LEFT JOIN platform_settings p ON p.key = ?2
LEFT JOIN platform_settings pc ON pc.key = ?3
WHERE r.id = ?1`;

/** A room's effective settings, as roomAccess computes them; null for an unknown room. */
export async function roomSettings(db: D1Database, roomId: string): Promise<RoomSettings | null> {
  const row = await db
    .prepare(SETTINGS_QUERY)
    .bind(roomId, ROOM_LIMITS_KEY, CAPABILITIES_KEY)
    .first<SettingsRow>();
  return row ? settingsOf(row) : null;
}
