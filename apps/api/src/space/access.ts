// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode, Role } from '@openlive/protocol';
import { type Actor, can } from '../auth/can';
import type { PresenceAccess } from './types';

interface SpaceAccessRow {
  suspended_at: number | null;
  is_platform_admin: number | null;
  user_ok: number | null;
  role: Role | null;
  banned_at: number | null;
}

const SPACE_ACCESS_QUERY = `
SELECT s.suspended_at, u.is_platform_admin, u.id IS NOT NULL AS user_ok, m.role, m.banned_at
FROM spaces s
LEFT JOIN users u ON u.id = ?2 AND u.deleted_at IS NULL AND u.banned_at IS NULL
LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ?2
WHERE s.id = ?1 AND s.deleted_at IS NULL`;

const GRANTS_QUERY = `
SELECT a.room_id, a.expires_at FROM room_access a
JOIN rooms r ON r.id = a.room_id
WHERE r.space_id = ?1 AND a.user_id = ?2 AND a.can_view = 1 AND r.visibility = 'restricted'
  AND (a.expires_at IS NULL OR a.expires_at > ?3)`;

export type PresenceAccessResult =
  { ok: true; access: PresenceAccess } | { ok: false; status: 401 | 403 | 404; code: ErrorCode };

/**
 * Whether `userId` may follow the space's room presence (can 'space.view') and which restricted
 * rooms they see there (PROTOCOL.md 7.8). Used by the upgrade and by the SpaceDO when someone's
 * access changes.
 */
export async function presenceAccess(
  db: D1Database,
  spaceId: string,
  userId: string,
  now: number = Date.now(),
): Promise<PresenceAccessResult> {
  const row = await db.prepare(SPACE_ACCESS_QUERY).bind(spaceId, userId).first<SpaceAccessRow>();
  if (!row) return { ok: false, status: 404, code: 'space_not_found' };
  if (!row.user_ok) return { ok: false, status: 401, code: 'unauthenticated' };
  if (row.suspended_at !== null) return { ok: false, status: 403, code: 'space_suspended' };
  const actor: Actor = {
    userId,
    isPlatformAdmin: row.is_platform_admin === 1,
    membership: row.role ? { spaceId, role: row.role, bannedAt: row.banned_at } : null,
  };
  // space.view does not read the space's settings.
  const space = { id: spaceId, settings: { membersCanInviteGuests: false } };
  if (!can(actor, 'space.view', { space }, now).allowed) {
    return { ok: false, status: 403, code: 'forbidden' };
  }
  // Managers see every restricted room (can's roomRole), so they need no grant list.
  if (row.role === 'owner' || row.role === 'admin') {
    return { ok: true, access: { all: true, restricted: [] } };
  }
  const { results } = await db
    .prepare(GRANTS_QUERY)
    .bind(spaceId, userId, now)
    .all<{ room_id: string; expires_at: number | null }>();
  return {
    ok: true,
    access: {
      all: false,
      restricted: results.map((r) => ({ roomId: r.room_id, expiresAt: r.expires_at })),
    },
  };
}

/** Whether a subscriber with `access` may see a room's summary (can 'room.view'). */
export function maySee(
  access: PresenceAccess,
  roomId: string,
  visibility: 'space' | 'restricted',
  now: number,
): boolean {
  if (visibility === 'space' || access.all) return true;
  return access.restricted.some(
    (g) => g.roomId === roomId && (g.expiresAt === null || g.expiresAt > now),
  );
}
