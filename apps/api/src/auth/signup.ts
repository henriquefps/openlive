// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode } from '@openlive/protocol';
import { z } from 'zod';
import { parseRoomCode } from '../api/rooms';
import { getInviteByHash } from '../db/invites';
import { accessPolicy } from '../db/platform';
import { getRoomByCode } from '../db/rooms';
import { getSpace } from '../db/spaces';
import { sha256Hex } from '../db/util';

// Who may create an account (platform setting `signup`). In `invite_only` mode a
// login that would create an account must carry an invite context: the invite token or the quick
// room code the person is about to use. It travels through the login (the signed OAuth state, the
// e-mail token row) and is checked here when the account would be created. Checking never takes a
// use of the invite: that happens when the invite is accepted.

/** What a login brings to justify a new account. Both fields are optional; one is enough. */
export interface SignupContext {
  /** A space or room invite token (/invite/:token). */
  invite?: string | undefined;
  /**
   * The SHA-256 of an invite token, as stored with a magic link: tokens live in D1 only as hashes
   *.
   */
  inviteHash?: string | undefined;
  /** A quick room's join code (/join/:code). */
  code?: string | undefined;
}

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The context fields as login requests accept them; anything malformed is dropped. */
export const signupContextInput = {
  invite: z.string().max(64).optional(),
  code: z.string().max(64).optional(),
};

/** Keeps only well-formed values, so they can be stored with the login state. */
export function cleanSignupContext(input: SignupContext): SignupContext {
  const out: SignupContext = {};
  if (input.invite && INVITE_TOKEN.test(input.invite)) out.invite = input.invite;
  if (input.inviteHash && SHA256_HEX.test(input.inviteHash)) out.inviteHash = input.inviteHash;
  const code = input.code ? parseRoomCode(input.code) : null;
  if (code) out.code = code;
  return out;
}

/** The context as stored with a magic link: the invite token is replaced by its hash. */
export async function storableSignupContext(context: SignupContext): Promise<SignupContext> {
  const { invite, inviteHash, code } = cleanSignupContext(context);
  const out: SignupContext = {};
  const hash = invite ? await sha256Hex(invite) : inviteHash;
  if (hash) out.inviteHash = hash;
  if (code) out.code = code;
  return out;
}

export type SignupDecision = { allowed: true } | { allowed: false; code: ErrorCode };

const ALLOW: SignupDecision = { allowed: true };
const deny = (code: ErrorCode): SignupDecision => ({ allowed: false, code });

/**
 * Whether the instance can still be claimed: an install code is set and there is no platform
 * admin yet.
 */
export async function instanceClaimable(env: Env): Promise<boolean> {
  if (!env.INSTALL_CODE?.trim()) return false;
  const hasAdmin = await env.DB.prepare(
    'SELECT 1 FROM users WHERE is_platform_admin = 1 AND deleted_at IS NULL LIMIT 1',
  ).first();
  return !hasAdmin;
}

async function inviteDecision(db: D1Database, tokenHash: string, now: number) {
  const invite = await getInviteByHash(db, tokenHash);
  if (!invite) return deny('invite_not_found');
  if (invite.revokedAt !== null) return deny('invite_revoked');
  if (invite.expiresAt <= now) return deny('invite_expired');
  if (invite.uses >= invite.maxUses) return deny('invite_exhausted');
  const space = await getSpace(db, invite.spaceId);
  if (!space) return deny('invite_not_found');
  if (space.suspendedAt !== null) return deny('space_suspended');
  if (invite.roomId !== null) {
    const room = await db
      .prepare('SELECT archived_at, expires_at FROM rooms WHERE id = ? AND space_id = ?')
      .bind(invite.roomId, invite.spaceId)
      .first<{ archived_at: number | null; expires_at: number | null }>();
    if (!room) return deny('invite_not_found');
    if (room.archived_at !== null || (room.expires_at !== null && room.expires_at <= now)) {
      return deny('room_closed');
    }
  }
  return ALLOW;
}

async function codeDecision(db: D1Database, code: string, now: number) {
  // No user yet, so no room_access row to join.
  const room = await getRoomByCode(db, code, '');
  if (!room) return deny('room_code_invalid');
  if (room.archivedAt !== null || (room.expiresAt !== null && room.expiresAt <= now)) {
    return deny('room_closed');
  }
  const space = await getSpace(db, room.spaceId);
  if (!space) return deny('room_code_invalid');
  if (space.suspendedAt !== null) return deny('space_suspended');
  // The code does not open a restricted room to outsiders, so it cannot justify an account.
  if (room.visibility === 'restricted') return deny('signup_invite_required');
  return ALLOW;
}

/**
 * Whether a login may create a new account. Existing accounts never ask: callers only call this
 * when no account matches. Open sign-up, or an instance nobody has claimed yet (so its owner can
 * sign in and claim it with the install code), always allows.
 */
export async function signupDecision(
  env: Env,
  context: SignupContext,
  now: number = Date.now(),
): Promise<SignupDecision> {
  const { signup } = await accessPolicy(env.DB);
  if (signup === 'open') return ALLOW;
  if (await instanceClaimable(env)) return ALLOW;
  const { invite, inviteHash, code } = cleanSignupContext(context);
  const hash = invite ? await sha256Hex(invite) : inviteHash;
  if (hash) {
    const d = await inviteDecision(env.DB, hash, now);
    // A failed invite falls back to the code, if the person also had one.
    if (d.allowed || !code) return d;
  }
  if (code) return codeDecision(env.DB, code, now);
  return deny('signup_invite_required');
}
