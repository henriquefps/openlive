// SPDX-License-Identifier: AGPL-3.0-only
export interface User {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string | null;
  isPlatformAdmin: boolean;
}

interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  locale: string | null;
  is_platform_admin: number;
}

/** A live (not deleted, not banned) user. Users are global, not per space. */
export async function getUser(db: D1Database, userId: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT id, display_name, avatar_url, locale, is_platform_admin
       FROM users WHERE id = ? AND deleted_at IS NULL AND banned_at IS NULL`,
    )
    .bind(userId)
    .first<UserRow>();
  return row
    ? {
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        locale: row.locale,
        isPlatformAdmin: row.is_platform_admin === 1,
      }
    : null;
}
