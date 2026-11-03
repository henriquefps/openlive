// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ChatSummary,
  ErrorCode,
  type ErrorPayload,
  type Message,
  type MessageId,
  type MessageType,
  type PayloadOf,
  type Role,
  type RoomSettings,
} from '@openlive/protocol';
import { canDeleteChatAs, canWriteChatAs } from '../auth/can';
import { STREAM_ONLY } from './capabilities';
import {
  CHAT_MAX_CHARS,
  CHAT_PAGE_DEFAULT,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  CHAT_UNREAD_CAP,
  charCount,
  DEFAULT_CHAT_RETENTION_DAYS,
  normalizeText,
  parseMentions,
  retentionMs,
} from './chat';
import { ChatStore, messageId, seqOf, toMessage } from './chat-store';
import type { Attachment } from './types';

// The room's text chat (docs/PROTOCOL.md 7.6). The RoomDO owns the
// sockets and hands chat messages here after its checks (web connection, text capability); this
// class owns the chat's tables and rules, and reaches the sockets through ChatHost.

/** Client messages of the text chat: web only, and need the text capability. */
export const CHAT_MESSAGES: ReadonlySet<MessageType> = new Set<MessageType>([
  'chat.send',
  'chat.edit',
  'chat.delete',
  'chat.history',
  'chat.read',
]);

/** What a deleted account's messages become (DELETE /api/admin/users/:userId). */
export type ChatErase = 'delete' | 'anonymize';

/** What the chat needs from the RoomDO. */
export interface ChatHost {
  settings(): RoomSettings | null;
  send<T extends MessageType>(ws: WebSocket, type: T, payload: PayloadOf<T>, id?: MessageId): void;
  /** To every web connection but `except`. */
  broadcastWeb<T extends MessageType>(type: T, payload: PayloadOf<T>, except?: WebSocket): void;
  sendError(ws: WebSocket, error: ErrorPayload, id?: MessageId): void;
  forbidden(ws: WebSocket, id?: MessageId): void;
  /** A present user's current role, or null when they are not connected. */
  roleOf(userId: string): Role | null;
  /** The user wrote here for the first time: the Worker records it (account deletion). */
  recordAuthor(userId: string): Promise<void>;
  /** The hub notice for a mention, to the user's web tabs. */
  notifyMention(userId: string, authorId: string): Promise<void>;
}

type ChatMessageIn = Extract<
  Message,
  { type: 'chat.send' | 'chat.edit' | 'chat.delete' | 'chat.history' | 'chat.read' }
>;

export class RoomChat {
  readonly store: ChatStore;

  constructor(
    sql: SqlStorage,
    private readonly host: ChatHost,
  ) {
    this.store = new ChatStore(sql);
  }

  async onMessage(ws: WebSocket, me: Attachment, msg: ChatMessageIn): Promise<void> {
    switch (msg.type) {
      case 'chat.send':
        return this.onSend(ws, me, msg.payload, msg.id);
      case 'chat.edit':
        return this.onEdit(ws, me, msg.payload, msg.id);
      case 'chat.delete':
        return this.onDelete(ws, me, msg.payload.messageId, msg.id);
      case 'chat.history':
        return this.onHistory(ws, msg.payload, msg.id);
      case 'chat.read':
        return this.onRead(ws, me, msg.payload.messageId, msg.id);
    }
  }

  /** A connection completed its hello: the room knows them by name (mentions). */
  connected(me: Attachment): void {
    this.store.rememberPerson(me.userId, me.displayName);
  }

  /** welcome.chat for a user. */
  summary(userId: string): ChatSummary {
    const read = this.store.readSeq(userId);
    return {
      unread: this.store.unread(userId, CHAT_UNREAD_CAP),
      ...(read !== null ? { lastReadId: messageId(read) } : {}),
    };
  }

  /** Unread messages for the space's room list. */
  unread(userId: string): number {
    return this.store.unread(userId, CHAT_UNREAD_CAP);
  }

  /** Unread messages, and how many of them mention the user, for the app's summary. */
  counts(userId: string): { unread: number; mentions: number } {
    return {
      unread: this.store.unread(userId, CHAT_UNREAD_CAP),
      mentions: this.store.unreadMentions(userId, CHAT_UNREAD_CAP),
    };
  }

  /** Removed, banned or lost access: no longer mentionable here. */
  forget(userId: string): void {
    this.store.forgetPerson(userId);
  }

  /** The last connection left: with no history, the chat goes. */
  emptied(): void {
    if (this.retentionDays() === 0) this.store.clear();
  }

  /** The room ended (quick room expiry, archive, delete): its chat goes with it. */
  ended(): void {
    this.store.clear();
  }

  /** When the oldest message expires, for the room's alarm; null when nothing will. */
  nextDeadline(): number | null {
    const days = this.retentionDays();
    if (days === 0) return null;
    const oldest = this.store.oldestCreatedAt();
    return oldest === null ? null : oldest + retentionMs(days);
  }

  /** The alarm: messages older than the retention go, without telling anyone. */
  sweep(now: number): void {
    const days = this.retentionDays();
    if (days > 0) this.store.deleteBefore(now - retentionMs(days));
  }

  /** Account deletion: the user's messages are deleted (and everyone told) or anonymized. */
  erase(userId: string, mode: ChatErase): number {
    if (mode === 'anonymize') return this.store.anonymizeAuthor(userId);
    const seqs = this.store.deleteAuthor(userId);
    for (const seq of seqs) this.host.broadcastWeb('chat.deleted', { messageId: messageId(seq) });
    return seqs.length;
  }

  private retentionDays(): number {
    return this.host.settings()?.chatRetentionDays ?? DEFAULT_CHAT_RETENTION_DAYS;
  }

  /** The text to store, or null after sending the error. Also takes from the rate limit. */
  private accept(ws: WebSocket, me: Attachment, raw: string, id?: MessageId): string | null {
    const settings = this.host.settings();
    const write = canWriteChatAs(
      me.role,
      settings?.capabilities ?? STREAM_ONLY,
      settings?.guestsCanWrite ?? true,
    );
    if (!write.allowed) {
      this.host.sendError(ws, { code: ErrorCode.ChatWriteNotAllowed }, id);
      return null;
    }
    const text = normalizeText(raw);
    if (text === '') {
      this.host.sendError(ws, { code: ErrorCode.InvalidMessage, path: '/payload/text' }, id);
      return null;
    }
    if (charCount(text) > CHAT_MAX_CHARS) {
      this.host.sendError(ws, { code: ErrorCode.ChatMessageTooLong, limit: CHAT_MAX_CHARS }, id);
      return null;
    }
    const wait = this.store.takeRate(me.userId, Date.now(), CHAT_RATE_MAX, CHAT_RATE_WINDOW_MS);
    if (wait !== null) {
      this.host.sendError(ws, { code: ErrorCode.RateLimited, retryAfterMs: wait }, id);
      return null;
    }
    return text;
  }

  private mentions(text: string, authorId: string): string[] {
    const people = this.store
      .people()
      .map((p) => ({ userId: p.user_id, displayName: p.display_name }));
    return parseMentions(text, people, authorId);
  }

  private async onSend(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'chat.send'>,
    id?: MessageId,
  ): Promise<void> {
    const text = this.accept(ws, me, p.text, id);
    if (text === null) return;
    const mentions = this.mentions(text, me.userId);
    const row = this.store.insert({
      user_id: me.userId,
      author_name: me.displayName,
      author_role: me.role,
      text,
      mentions,
      created_at: Date.now(),
    });
    // Your own message is read.
    this.store.markRead(me.userId, row.seq);
    const message = toMessage(row);
    this.host.send(ws, 'chat.message', { message, clientId: p.clientId }, id);
    this.host.broadcastWeb('chat.message', { message }, ws);
    const first = this.store.markWrote(me.userId);
    await Promise.all([
      ...(first ? [this.host.recordAuthor(me.userId)] : []),
      ...mentions.map((userId) => this.host.notifyMention(userId, me.userId)),
    ]);
  }

  private async onEdit(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'chat.edit'>,
    id?: MessageId,
  ): Promise<void> {
    const row = this.find(ws, p.messageId, id);
    if (!row) return;
    if (row.user_id !== me.userId) return this.host.forbidden(ws, id);
    const text = this.accept(ws, me, p.text, id);
    if (text === null) return;
    const mentions = this.mentions(text, me.userId);
    const editedAt = Date.now();
    this.store.edit(row.seq, text, mentions, editedAt);
    const payload = { messageId: p.messageId, text, editedAt, mentions };
    this.host.send(ws, 'chat.edited', payload, id);
    this.host.broadcastWeb('chat.edited', payload, ws);
    // Only people newly mentioned hear about it.
    const added = mentions.filter((u) => !row.mentions.includes(u));
    await Promise.all(added.map((userId) => this.host.notifyMention(userId, me.userId)));
  }

  private onDelete(ws: WebSocket, me: Attachment, id_: string, id?: MessageId): void {
    const row = this.find(ws, id_, id);
    if (!row) return;
    // The author's role now if they are here, else as it was when they wrote; a removed account
    // counts as a guest.
    const authorRole: Role =
      row.user_id === null ? 'guest' : (this.host.roleOf(row.user_id) ?? row.author_role);
    const decision = canDeleteChatAs(
      me.role,
      me.userId,
      this.host.settings()?.capabilities ?? STREAM_ONLY,
      { userId: row.user_id ?? '', role: authorRole, invitedBy: null },
    );
    if (!decision.allowed) return this.host.forbidden(ws, id);
    this.store.softDelete(row.seq, Date.now());
    this.host.send(ws, 'chat.deleted', { messageId: id_ }, id);
    this.host.broadcastWeb('chat.deleted', { messageId: id_ }, ws);
  }

  private onHistory(ws: WebSocket, p: PayloadOf<'chat.history'>, id?: MessageId): void {
    // An unknown `before` (expired, or not ours) pages from the newest.
    const before = p.before === undefined ? null : seqOf(p.before);
    const { rows, hasMore } = this.store.page(before, p.limit ?? CHAT_PAGE_DEFAULT);
    this.host.send(ws, 'chat.page', { messages: rows.map(toMessage), hasMore }, id);
  }

  private onRead(ws: WebSocket, me: Attachment, id_: string, id?: MessageId): void {
    const seq = seqOf(id_);
    // A message deleted meanwhile still marks what came before it as read.
    if (seq === null || seq > (this.store.latestSeqAny() ?? 0)) {
      return this.host.sendError(ws, { code: ErrorCode.ChatMessageNotFound, messageId: id_ }, id);
    }
    this.store.markRead(me.userId, seq);
    if (id) this.host.send(ws, 'ack', {}, id);
  }

  private find(ws: WebSocket, id_: string, id?: MessageId) {
    const seq = seqOf(id_);
    const row = seq === null ? null : this.store.message(seq);
    if (!row) {
      this.host.sendError(ws, { code: ErrorCode.ChatMessageNotFound, messageId: id_ }, id);
    }
    return row;
  }
}
