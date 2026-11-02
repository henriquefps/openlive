// SPDX-License-Identifier: AGPL-3.0-only
import { isUniqueViolation, newId } from '../db/util';

// Users and their login identities. One user may hold a Discord and an e-mail
// identity. Accounts are joined only when the person proves both: a Discord account whose
// verified e-mail matches an existing account is linked after a magic link to that e-mail.

export type Provider = 'discord' | 'email';

export interface NewUser {
  displayName: string;
  avatarUrl: string | null;
  /** A verified address only; becomes users.primary_email. */
  email: string | null;
  locale: string | null;
}

export async function userByIdentity(
  db: D1Database,
  provider: Provider,
  providerUserId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT u.id FROM identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = ? AND i.provider_user_id = ? AND u.deleted_at IS NULL`,
    )
    .bind(provider, providerUserId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** The live user who owns a verified address: by e-mail identity, then by primary e-mail. */
export async function userByEmail(db: D1Database, email: string): Promise<string | null> {
  return (
    (await userByIdentity(db, 'email', email)) ??
    (
      await db
        .prepare('SELECT id FROM users WHERE primary_email = ? AND deleted_at IS NULL')
        .bind(email)
        .first<{ id: string }>()
    )?.id ??
    null
  );
}

const identityStatement = (
  db: D1Database,
  userId: string,
  provider: Provider,
  providerUserId: string,
  email: string | null,
) =>
  db
    .prepare(
      `INSERT INTO identities (id, user_id, provider, provider_user_id, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId('id'), userId, provider, providerUserId, email, Date.now());

/**
 * Creates a user with one identity. Returns null when the e-mail turned out to belong to
 * someone else (a concurrent sign-up): the caller then treats it as an existing account.
 */
export async function createUser(
  db: D1Database,
  user: NewUser,
  provider: Provider,
  providerUserId: string,
): Promise<string | null> {
  const id = newId('u');
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, display_name, avatar_url, discord_avatar_url, primary_email,
             locale, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          user.displayName,
          user.avatarUrl,
          provider === 'discord' ? user.avatarUrl : null,
          user.email,
          user.locale,
          Date.now(),
        ),
      identityStatement(db, id, provider, providerUserId, user.email),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  return id;
}

/** Adds an identity; false when that provider account is already someone's identity. */
export async function addIdentity(
  db: D1Database,
  userId: string,
  provider: Provider,
  providerUserId: string,
  email: string | null,
): Promise<boolean> {
  try {
    await identityStatement(db, userId, provider, providerUserId, email).run();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}
