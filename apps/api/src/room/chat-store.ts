// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatMessage, Role } from '@openlive/protocol';

// The text chat's durable state, in the RoomDO's SQLite next to the rest of the room
//: messages, each user's read position, the people the room knows
// by name (for @mentions) and the recent sends of each user (rate limit). Nothing here is in D1:
// the chat goes away with the room.

const SCHEMA = `
-- seq orders the chat; the id clients see is m_<seq>. A deleted message keeps its row (and seq)
-- with the text cleared until retention removes it.
CREATE TABLE IF NOT EXISTS chat_messages (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  author_name   TEXT NOT NULL,
  author_role   TEXT NOT NULL,
  text          TEXT NOT NULL,
  mentions_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages (created_at);
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages (user_id);
-- The newest message each user marked as read (chat.read), from any tab.
CREATE TABLE IF NOT EXISTS chat_reads (
  user_id  TEXT PRIMARY KEY,
  read_seq INTEGER NOT NULL
);
-- Everyone who connected to the room and may still see it, by display name (mentions). wrote = 1
-- once they sent a message here (the Worker then knows this room holds their messages).
CREATE TABLE IF NOT EXISTS chat_people (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  wrote        INTEGER NOT NULL DEFAULT 0
);
-- The rate limit lives in memory now: it wrote four rows per message.
DROP TABLE IF EXISTS chat_rate;
`;

export interface ChatRow {
  seq: number;
  user_id: string | null;
  author_name: string;
  author_role: Role;
  text: string;
  mentions: string[];
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

type Row = Record<string, SqlStorageValue>;

export const messageId = (seq: number): string => `m_${seq}`;

/** The seq of a message id, or null when it is not one of ours. */
export function seqOf(id: string): number | null {
  const match = /^m_([1-9][0-9]{0,15})$/.exec(id);
  return match ? Number(match[1]) : null;
}

export function toMessage(row: ChatRow): ChatMessage {
  return {
    id: messageId(row.seq),
    ...(row.user_id !== null ? { userId: row.user_id } : {}),
    authorName: row.author_name,
    text: row.text,
    createdAt: row.created_at,
    ...(row.edited_at !== null ? { editedAt: row.edited_at } : {}),
    mentions: row.mentions,
  };
}

export class ChatStore {
  /**
   * Sends and edits of the last window, per user (rate limit). In memory: a wake-up forgets them,
   * which only lets a user who was quiet long enough for the object to be evicted send again.
   */
  private readonly rate = new Map<string, number[]>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec(SCHEMA);
  }

  private all<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec<Row>(query, ...bindings).toArray() as T[];
  }

  private rowOf(r: Row): ChatRow {
    return {
      seq: r['seq'] as number,
      user_id: r['user_id'] as string | null,
      author_name: r['author_name'] as string,
      author_role: r['author_role'] as Role,
      text: r['text'] as string,
      mentions: JSON.parse(r['mentions_json'] as string) as string[],
      created_at: r['created_at'] as number,
      edited_at: r['edited_at'] as number | null,
      deleted_at: r['deleted_at'] as number | null,
    };
  }

  // --- Messages ---

  insert(m: Omit<ChatRow, 'seq' | 'edited_at' | 'deleted_at'>): ChatRow {
    const row = this.all<Row>(
      `INSERT INTO chat_messages (user_id, author_name, author_role, text, mentions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      m.user_id,
      m.author_name,
      m.author_role,
      m.text,
      JSON.stringify(m.mentions),
      m.created_at,
    )[0];
    if (!row) throw new Error('chat insert returned nothing');
    return this.rowOf(row);
  }

  /** A live (not deleted) message. */
  message(seq: number): ChatRow | null {
    const row = this.all<Row>(
      'SELECT * FROM chat_messages WHERE seq = ? AND deleted_at IS NULL',
      seq,
    )[0];
    return row ? this.rowOf(row) : null;
  }

  edit(seq: number, text: string, mentions: string[], at: number): void {
    this.sql.exec(
      'UPDATE chat_messages SET text = ?, mentions_json = ?, edited_at = ? WHERE seq = ?',
      text,
      JSON.stringify(mentions),
      at,
      seq,
    );
  }

  /** Clears the text at once (nothing of it stays); retention removes the row later. */
  softDelete(seq: number, at: number): void {
    this.sql.exec(
      "UPDATE chat_messages SET text = '', mentions_json = '[]', deleted_at = ? WHERE seq = ?",
      at,
      seq,
    );
  }

  /** The newest `limit` live messages before `beforeSeq` (or of all), oldest first. */
  page(beforeSeq: number | null, limit: number): { rows: ChatRow[]; hasMore: boolean } {
    const rows = this.all<Row>(
      `SELECT * FROM chat_messages WHERE deleted_at IS NULL AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
      beforeSeq ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    ).map((r) => this.rowOf(r));
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), hasMore };
  }

  /** Live messages by others after `afterSeq`, counted up to `cap`. */
  unread(userId: string, cap: number): number {
    const after = this.readSeq(userId) ?? 0;
    const row = this.all<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM chat_messages
         WHERE seq > ? AND deleted_at IS NULL AND (user_id IS NULL OR user_id != ?) LIMIT ?)`,
      after,
      userId,
      cap,
    )[0];
    return row?.n ?? 0;
  }

  /** Unread live messages by others that mention the user, counted up to `cap`. */
  unreadMentions(userId: string, cap: number): number {
    const after = this.readSeq(userId) ?? 0;
    const row = this.all<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM chat_messages
         WHERE seq > ? AND deleted_at IS NULL AND (user_id IS NULL OR user_id != ?)
           AND EXISTS (SELECT 1 FROM json_each(mentions_json) WHERE value = ?) LIMIT ?)`,
      after,
      userId,
      userId,
      cap,
    )[0];
    return row?.n ?? 0;
  }

  /** The highest seq ever given, deleted and expired messages included. */
  latestSeqAny(): number | null {
    const row = this.all<{ seq: number }>(
      "SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'",
    )[0];
    return row?.seq ?? null;
  }

  /** Deletes the messages created before `cutoff` (retention); returns how many. */
  deleteBefore(cutoff: number): number {
    return this.all('DELETE FROM chat_messages WHERE created_at < ? RETURNING seq', cutoff).length;
  }

  /** When the oldest message was created, for the retention alarm. */
  oldestCreatedAt(): number | null {
    const row = this.all<{ t: number | null }>('SELECT min(created_at) AS t FROM chat_messages')[0];
    return row?.t ?? null;
  }

  count(): number {
    return this.all<{ n: number }>('SELECT count(*) AS n FROM chat_messages')[0]?.n ?? 0;
  }

  /** No history, or the room ended: every message and read position goes. */
  clear(): void {
    this.sql.exec('DELETE FROM chat_messages');
    this.sql.exec('DELETE FROM chat_reads');
    this.rate.clear();
  }

  // --- Account deletion ---

  /** Deletes a user's live messages; returns their seqs. Their mentions go too. */
  deleteAuthor(userId: string): number[] {
    const seqs = this.all<{ seq: number }>(
      'DELETE FROM chat_messages WHERE user_id = ? RETURNING seq',
      userId,
    ).map((r) => r.seq);
    this.forgetMentions(userId);
    this.forgetPerson(userId);
    return seqs;
  }

  /** Keeps a user's messages without them ("account removed"); returns how many. */
  anonymizeAuthor(userId: string): number {
    const n = this.all(
      "UPDATE chat_messages SET user_id = NULL, author_name = '' WHERE user_id = ? RETURNING seq",
      userId,
    ).length;
    this.forgetMentions(userId);
    this.forgetPerson(userId);
    return n;
  }

  private forgetMentions(userId: string): void {
    const rows = this.all<{ seq: number; mentions_json: string }>(
      `SELECT seq, mentions_json FROM chat_messages
       WHERE EXISTS (SELECT 1 FROM json_each(mentions_json) WHERE value = ?)`,
      userId,
    );
    for (const r of rows) {
      const mentions = (JSON.parse(r.mentions_json) as string[]).filter((u) => u !== userId);
      this.sql.exec(
        'UPDATE chat_messages SET mentions_json = ? WHERE seq = ?',
        JSON.stringify(mentions),
        r.seq,
      );
    }
    this.sql.exec('DELETE FROM chat_reads WHERE user_id = ?', userId);
    this.rate.delete(userId);
  }

  // --- Read positions ---

  readSeq(userId: string): number | null {
    return (
      this.all<{ read_seq: number }>('SELECT read_seq FROM chat_reads WHERE user_id = ?', userId)[0]
        ?.read_seq ?? null
    );
  }

  /** Moves a user's read position forward (never back). */
  markRead(userId: string, seq: number): void {
    this.sql.exec(
      `INSERT INTO chat_reads (user_id, read_seq) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET read_seq = excluded.read_seq
       WHERE excluded.read_seq > read_seq`,
      userId,
      seq,
    );
  }

  // --- People (mentions) ---

  /** Remembers a connected user's name (no write when it is the same). */
  rememberPerson(userId: string, displayName: string): void {
    this.sql.exec(
      `INSERT INTO chat_people (user_id, display_name) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name
       WHERE display_name <> excluded.display_name`,
      userId,
      displayName,
    );
  }

  /** Removed, banned or lost access: no longer mentionable here. */
  forgetPerson(userId: string): void {
    this.sql.exec('DELETE FROM chat_people WHERE user_id = ?', userId);
  }

  people(): { user_id: string; display_name: string }[] {
    return this.all('SELECT user_id, display_name FROM chat_people');
  }

  /** Marks that the user wrote here; true the first time. */
  markWrote(userId: string): boolean {
    return (
      this.all(
        'UPDATE chat_people SET wrote = 1 WHERE user_id = ? AND wrote = 0 RETURNING user_id',
        userId,
      ).length > 0
    );
  }

  // --- Rate limit ---

  /**
   * Records a send or edit if the user has fewer than `max` in the last `windowMs`; otherwise
   * returns how long until the oldest one leaves the window.
   */
  takeRate(userId: string, now: number, max: number, windowMs: number): number | null {
    const recent = (this.rate.get(userId) ?? []).filter((at) => at > now - windowMs);
    if (recent.length >= max) {
      this.rate.set(userId, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, oldest + windowMs - now);
    }
    this.rate.set(userId, [...recent, now]);
    return null;
  }
}
