// SPDX-License-Identifier: AGPL-3.0-only
import { sha256Hex } from '../db/util';
import type { Provider } from './accounts';

// Platform bans: a banned account cannot sign in, and its login identities are
// recorded so that a new sign-up with the same Discord account or e-mail address is refused too,
// also after the account was deleted. banned_identities keeps only a hash of each identity.

/** The banned_identities key of a Discord user id or an e-mail address (lower case). */
export const identityHash = (provider: Provider, value: string): Promise<string> =>
  sha256Hex(`${provider}:${provider === 'email' ? value.trim().toLowerCase() : value}`);

/** Whether any of these identities belongs to a banned account (or a deleted, banned one). */
export async function identityBanned(
  db: D1Database,
  identities: { discordId?: string | null; email?: string | null },
): Promise<boolean> {
  const hashes: string[] = [];
  if (identities.discordId) hashes.push(await identityHash('discord', identities.discordId));
  if (identities.email) hashes.push(await identityHash('email', identities.email));
  if (hashes.length === 0) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM banned_identities WHERE identity_hash IN (${hashes.map(() => '?').join(', ')})
       LIMIT 1`,
    )
    .bind(...hashes)
    .first();
  return row !== null;
}

/** Whether the account is banned. */
export async function userBanned(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM users WHERE id = ? AND banned_at IS NOT NULL')
    .bind(userId)
    .first();
  return row !== null;
}

/**
 * The statements that record every login identity of `userId` (its identities and its primary
 * e-mail) as banned. Idempotent.
 */
export async function banIdentityStatements(
  db: D1Database,
  userId: string,
  actorId: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const [{ results: identities }, user] = await Promise.all([
    db
      .prepare('SELECT provider, provider_user_id FROM identities WHERE user_id = ?')
      .bind(userId)
      .all<{ provider: Provider; provider_user_id: string }>(),
    db
      .prepare('SELECT primary_email FROM users WHERE id = ?')
      .bind(userId)
      .first<{ primary_email: string | null }>(),
  ]);
  const all: { provider: Provider; value: string }[] = identities.map((i) => ({
    provider: i.provider,
    value: i.provider_user_id,
  }));
  if (user?.primary_email) all.push({ provider: 'email', value: user.primary_email });
  const hashes = new Map<string, Provider>();
  for (const i of all) hashes.set(await identityHash(i.provider, i.value), i.provider);
  return [...hashes].map(([hash, provider]) =>
    db
      .prepare(
        `INSERT INTO banned_identities (identity_hash, provider, user_id, banned_by, banned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (identity_hash) DO UPDATE SET user_id = excluded.user_id`,
      )
      .bind(hash, provider, userId, actorId, now),
  );
}
