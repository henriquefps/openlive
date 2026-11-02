// SPDX-License-Identifier: AGPL-3.0-only
import { newId } from './util';

export interface AuditEntry {
  spaceId: string | null;
  actorId: string;
  /** Dotted verb, e.g. `member.role.change`. */
  action: string;
  /** The id the action applies to (user, room, invite or join request). */
  target: string | null;
  data?: Record<string, unknown>;
}

/**
 * An audit_log insert, returned as a statement so it commits in the same batch (one transaction)
 * as the change it records (every role or permission change is audited).
 */
export function auditStatement(db: D1Database, e: AuditEntry, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, space_id, actor_id, action, target, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId('al'), e.spaceId, e.actorId, e.action, e.target, JSON.stringify(e.data ?? {}), now);
}
