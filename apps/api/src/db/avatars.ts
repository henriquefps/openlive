// SPDX-License-Identifier: AGPL-3.0-only

// Profile photos (migrations/0012_avatars.sql). An uploaded photo is one R2 object per person,
// overwritten on each upload; users.avatar_url points at it with a version, so a new photo is a
// new URL the browser has never cached, and an old URL stops being served (404).

/** The R2 key of a person's uploaded photo, in the instance's private bucket. */
export const avatarKey = (userId: string) => `avatars/${userId}`;

/** The URL users.avatar_url holds for an uploaded photo. */
export const avatarPath = (userId: string, version: string) =>
  `/api/avatars/${encodeURIComponent(userId)}/${encodeURIComponent(version)}`;

/** Where the shown photo comes from: Discord (also "no photo yet"), an upload, or removed. */
export type AvatarSource = 'discord' | 'upload' | 'none';

export interface AvatarState {
  source: AvatarSource;
  /** The account has a Discord photo to go back to ("Use my Discord photo"). */
  discordAvailable: boolean;
}

interface AvatarRow {
  avatar_url: string | null;
  avatar_source: 'upload' | 'none' | null;
  discord_avatar_url: string | null;
}

export async function avatarState(db: D1Database, userId: string): Promise<AvatarState> {
  const row = await db
    .prepare('SELECT avatar_url, avatar_source, discord_avatar_url FROM users WHERE id = ?')
    .bind(userId)
    .first<AvatarRow>();
  return {
    source: row?.avatar_source ?? (row?.avatar_url ? 'discord' : 'none'),
    discordAvailable: Boolean(row?.discord_avatar_url),
  };
}

/**
 * Whether two people share a live space: as members (any role, not banned) or as guests of one
 * of its rooms (a room_access row that lets them view). Suspended and deleted spaces do not count.
 */
export async function shareSpace(
  db: D1Database,
  a: string,
  b: string,
  now: number,
): Promise<boolean> {
  const spacesOf = (p: string) => `
    SELECT space_id FROM space_members WHERE user_id = ?${p} AND banned_at IS NULL
    UNION
    SELECT r.space_id FROM room_access x JOIN rooms r ON r.id = x.room_id
    WHERE x.user_id = ?${p} AND x.can_view = 1 AND (x.expires_at IS NULL OR x.expires_at > ?3)`;
  const row = await db
    .prepare(
      `SELECT 1 AS one FROM (${spacesOf('1')}) va
       JOIN (${spacesOf('2')}) vb ON vb.space_id = va.space_id
       JOIN spaces s ON s.id = va.space_id AND s.deleted_at IS NULL AND s.suspended_at IS NULL
       LIMIT 1`,
    )
    .bind(a, b, now)
    .first<{ one: number }>();
  return row !== null;
}
