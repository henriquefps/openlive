// SPDX-License-Identifier: AGPL-3.0-only
// invites and join_requests. Lookups by token hash or id are the entry points (the space_id comes
// from the row); every write also names the space.

export interface Invite {
  id: string;
  spaceId: string;
  roomId: string | null;
  role: 'member' | 'guest';
  canStream: boolean;
  requiresApproval: boolean;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdBy: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface JoinRequest {
  id: string;
  spaceId: string;
  roomId: string | null;
  userId: string;
  displayName: string | null;
  inviteId: string | null;
  status: JoinRequestStatus;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

interface InviteRow {
  id: string;
  space_id: string;
  room_id: string | null;
  role: 'member' | 'guest';
  can_stream: number;
  requires_approval: number;
  max_uses: number;
  uses: number;
  expires_at: number;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface JoinRequestRow {
  id: string;
  space_id: string;
  room_id: string | null;
  user_id: string;
  display_name: string | null;
  invite_id: string | null;
  status: JoinRequestStatus;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  spaceId: r.space_id,
  roomId: r.room_id,
  role: r.role,
  canStream: r.can_stream === 1,
  requiresApproval: r.requires_approval === 1,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

const toJoinRequest = (r: JoinRequestRow): JoinRequest => ({
  id: r.id,
  spaceId: r.space_id,
  roomId: r.room_id,
  userId: r.user_id,
  displayName: r.display_name,
  inviteId: r.invite_id,
  status: r.status,
  decidedBy: r.decided_by,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const INVITE_SELECT = `
SELECT i.id, i.space_id, i.room_id, i.role, i.can_stream, i.requires_approval, i.max_uses, i.uses,
       i.expires_at, i.created_by, i.created_at, i.revoked_at
FROM invites i JOIN spaces s ON s.id = i.space_id AND s.deleted_at IS NULL`;

export async function getInviteByHash(db: D1Database, tokenHash: string): Promise<Invite | null> {
  const row = await db
    .prepare(`${INVITE_SELECT} WHERE i.token_hash = ?`)
    .bind(tokenHash)
    .first<InviteRow>();
  return row ? toInvite(row) : null;
}

export async function getInvite(db: D1Database, inviteId: string): Promise<Invite | null> {
  const row = await db.prepare(`${INVITE_SELECT} WHERE i.id = ?`).bind(inviteId).first<InviteRow>();
  return row ? toInvite(row) : null;
}

/** The space's invites that can still be used (not revoked, not expired, not used up). */
export async function listActiveInvites(
  db: D1Database,
  spaceId: string,
  now: number,
): Promise<Invite[]> {
  const { results } = await db
    .prepare(
      `${INVITE_SELECT} WHERE i.space_id = ? AND i.revoked_at IS NULL AND i.expires_at > ?
       AND i.uses < i.max_uses ORDER BY i.created_at`,
    )
    .bind(spaceId, now)
    .all<InviteRow>();
  return results.map(toInvite);
}

export function insertInviteStatement(
  db: D1Database,
  invite: Omit<Invite, 'uses' | 'revokedAt'>,
  tokenHash: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO invites (id, space_id, room_id, token_hash, role, can_stream, requires_approval,
                            max_uses, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invite.id,
      invite.spaceId,
      invite.roomId,
      tokenHash,
      invite.role,
      invite.canStream ? 1 : 0,
      invite.requiresApproval ? 1 : 0,
      invite.maxUses,
      invite.expiresAt,
      invite.createdBy,
      invite.createdAt,
    );
}

export function revokeInviteStatement(
  db: D1Database,
  spaceId: string,
  inviteId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE invites SET revoked_at = ? WHERE id = ? AND space_id = ? AND revoked_at IS NULL',
    )
    .bind(now, inviteId, spaceId);
}

/**
 * Takes one use of the invite if it is still valid. The condition and the increment are one
 * statement, so two people racing for the last use cannot both get it. Returns whether it worked.
 */
export async function consumeInvite(
  db: D1Database,
  spaceId: string,
  inviteId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE invites SET uses = uses + 1
       WHERE id = ? AND space_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses`,
    )
    .bind(inviteId, spaceId, now)
    .run();
  return result.meta.changes === 1;
}

// --- join_requests ---

const JOIN_REQUEST_SELECT = `
SELECT j.id, j.space_id, j.room_id, j.user_id, u.display_name, j.invite_id, j.status, j.decided_by,
       j.created_at, j.decided_at
FROM join_requests j
JOIN spaces s ON s.id = j.space_id AND s.deleted_at IS NULL
LEFT JOIN users u ON u.id = j.user_id`;

export async function getJoinRequest(db: D1Database, id: string): Promise<JoinRequest | null> {
  const row = await db
    .prepare(`${JOIN_REQUEST_SELECT} WHERE j.id = ?`)
    .bind(id)
    .first<JoinRequestRow>();
  return row ? toJoinRequest(row) : null;
}

/** The pending request of `userId` for the space (roomId null) or for one room. */
export async function getPendingJoinRequest(
  db: D1Database,
  spaceId: string,
  userId: string,
  roomId: string | null,
): Promise<JoinRequest | null> {
  const row = await db
    .prepare(
      `${JOIN_REQUEST_SELECT} WHERE j.space_id = ? AND j.user_id = ?
       AND coalesce(j.room_id, '') = ? AND j.status = 'pending'`,
    )
    .bind(spaceId, userId, roomId ?? '')
    .first<JoinRequestRow>();
  return row ? toJoinRequest(row) : null;
}

export async function listJoinRequests(
  db: D1Database,
  spaceId: string,
  status: JoinRequestStatus,
): Promise<JoinRequest[]> {
  const { results } = await db
    .prepare(`${JOIN_REQUEST_SELECT} WHERE j.space_id = ? AND j.status = ? ORDER BY j.created_at`)
    .bind(spaceId, status)
    .all<JoinRequestRow>();
  return results.map(toJoinRequest);
}

export function insertJoinRequestStatement(
  db: D1Database,
  r: { id: string; spaceId: string; roomId: string | null; userId: string; inviteId: string },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO join_requests (id, space_id, room_id, user_id, invite_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.spaceId, r.roomId, r.userId, r.inviteId, now);
}

/** Decides a pending request; a no-op (0 changes) if someone decided it first. */
export function decideJoinRequestStatement(
  db: D1Database,
  spaceId: string,
  id: string,
  status: 'approved' | 'rejected',
  decidedBy: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE join_requests SET status = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND space_id = ? AND status = 'pending'`,
    )
    .bind(status, decidedBy, now, id, spaceId);
}
