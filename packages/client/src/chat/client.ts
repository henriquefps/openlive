// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatMessage, ErrorPayload, Message } from '@openlive/protocol';

// The room's text chat (docs/PROTOCOL.md 7.6): the messages of the room socket turned
// into a list the panel renders. It keeps the newest page and whatever older pages the reader
// scrolled to, sends with an optimistic copy (matched back by clientId), applies edits and
// deletes from anyone, counts unread messages while the chat is out of sight and marks them read
// (chat.read) when it comes into view.
//
// Only types come from @openlive/protocol (see socket/session.ts).

/** What the chat needs from the room socket (room/connection.ts). */
export interface ChatSocket {
  /** Hears every message of the room. */
  listen(listener: (message: Message) => void): () => void;
  /** Sends a request with a fresh id; null while the room is not open. */
  request(type: ChatRequest, payload: object): string | null;
}

export type ChatRequest = 'chat.send' | 'chat.edit' | 'chat.delete' | 'chat.history' | 'chat.read';

/** Longest message (code points), as the room enforces it. */
export const CHAT_MAX_CHARS = 2_000;
export const CHAT_PAGE = 50;

/** A message in the list; `pending` while the room has not confirmed it, `failed` if it refused. */
export interface ChatEntry extends ChatMessage {
  clientId?: string;
  pending?: true;
  failed?: ErrorPayload;
}

export interface ChatState {
  /** `loading` until the first page arrives after a welcome. */
  status: 'off' | 'loading' | 'ready';
  /** Oldest first. */
  messages: ChatEntry[];
  /** Older messages exist before the first one. */
  hasMore: boolean;
  loadingOlder: boolean;
  /** Messages by others not seen yet. */
  unread: number;
  /** The newest message this user read, from any tab. */
  lastReadId: string | null;
  /** The last refusal of an edit or delete, for a toast. */
  error: ErrorPayload | null;
}

export const INITIAL_CHAT: ChatState = {
  status: 'off',
  messages: [],
  hasMore: false,
  loadingOlder: false,
  unread: 0,
  lastReadId: null,
  error: null,
};

/** Ids ordered by the room: m_<seq>. */
export function seqOf(id: string): number {
  const match = /^m_(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export const charCount = (text: string): number => [...text].length;

export interface ChatClientOptions {
  socket: ChatSocket;
  /** A message mentions this user while the chat is out of sight. */
  onMention?: (message: ChatMessage) => void;
  newClientId?: () => string;
  now?: () => number;
}

export class ChatClient {
  private state: ChatState = INITIAL_CHAT;
  private readonly listeners = new Set<() => void>();
  private selfId: string | null = null;
  private selfName = '';
  /** Whether the reader can see the newest messages now (panel visible, window focused). */
  private active = false;
  /** Request ids waiting for an answer: what they were for. */
  private readonly requests = new Map<
    string,
    | { kind: 'page'; initial: boolean }
    | { kind: 'send'; clientId: string }
    | { kind: 'edit' | 'delete' | 'read' }
  >();
  private readonly newClientId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: ChatClientOptions) {
    this.newClientId = options.newClientId ?? (() => crypto.randomUUID().slice(0, 12));
    this.now = options.now ?? Date.now;
  }

  /** Starts listening to the room socket (before it opens, to see the welcome); returns stop. */
  start(): () => void {
    return this.options.socket.listen((message) => this.onMessage(message));
  }

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The reader sees (or no longer sees) the newest messages: seen ones are marked read. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) this.markRead();
  }

  send(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '' || this.selfId === null) return;
    const clientId = this.newClientId();
    const entry: ChatEntry = {
      id: `pending_${clientId}`,
      userId: this.selfId,
      authorName: this.selfName,
      text: trimmed,
      createdAt: this.now(),
      mentions: [],
      clientId,
      pending: true,
    };
    this.set({ messages: [...this.state.messages, entry] });
    this.sendEntry(entry);
  }

  /** Sends a failed message again. */
  retry(clientId: string): void {
    const entry = this.state.messages.find((m) => m.clientId === clientId && m.failed);
    if (!entry) return;
    const again: ChatEntry = { ...entry, pending: true };
    delete again.failed;
    this.replace(entry.id, again);
    this.sendEntry(again);
  }

  /** Drops a failed message from the list. */
  discard(clientId: string): void {
    this.set({ messages: this.state.messages.filter((m) => m.clientId !== clientId) });
  }

  edit(messageId: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const id = this.options.socket.request('chat.edit', { messageId, text: trimmed });
    if (id !== null) this.requests.set(id, { kind: 'edit' });
  }

  delete(messageId: string): void {
    const id = this.options.socket.request('chat.delete', { messageId });
    if (id !== null) this.requests.set(id, { kind: 'delete' });
  }

  /** The page before the oldest message shown (infinite scroll). */
  loadOlder(): void {
    if (!this.state.hasMore || this.state.loadingOlder || this.state.status !== 'ready') return;
    const oldest = this.state.messages.find((m) => !m.pending && !m.failed);
    if (!oldest) return;
    const id = this.options.socket.request('chat.history', { before: oldest.id, limit: CHAT_PAGE });
    if (id === null) return;
    this.requests.set(id, { kind: 'page', initial: false });
    this.set({ loadingOlder: true });
  }

  clearError(): void {
    this.set({ error: null });
  }

  private sendEntry(entry: ChatEntry): void {
    const clientId = entry.clientId ?? '';
    const id = this.options.socket.request('chat.send', { text: entry.text, clientId });
    if (id === null) {
      this.replace(entry.id, failedEntry(entry, { code: 'internal_error' }));
      return;
    }
    this.requests.set(id, { kind: 'send', clientId });
  }

  private onMessage(message: Message): void {
    const request = message.id === undefined ? undefined : this.requests.get(message.id);
    if (request && message.id !== undefined) this.requests.delete(message.id);
    switch (message.type) {
      case 'welcome': {
        const { you, settings, chat } = message.payload;
        this.selfId = you.userId;
        this.selfName =
          message.payload.members.find((m) => m.userId === you.userId)?.displayName ?? '';
        this.requests.clear();
        const on = settings.capabilities?.text === true && you.permissions.canReadChat !== false;
        // Sends that never got an answer (the socket closed) can be retried.
        const unsent = this.state.messages
          .filter((m) => m.pending || m.failed)
          .map((m) => failedEntry(m, m.failed ?? { code: 'internal_error' }));
        this.set({
          ...INITIAL_CHAT,
          status: on ? 'loading' : 'off',
          messages: unsent,
          unread: chat?.unread ?? 0,
          lastReadId: chat?.lastReadId ?? null,
        });
        if (on) {
          const id = this.options.socket.request('chat.history', { limit: CHAT_PAGE });
          if (id !== null) this.requests.set(id, { kind: 'page', initial: true });
        }
        return;
      }
      case 'room.updated':
        if (message.payload.settings.capabilities?.text === false) this.set({ ...INITIAL_CHAT });
        return;
      case 'chat.page': {
        if (request?.kind !== 'page') return;
        const { messages, hasMore } = message.payload;
        if (request.initial) {
          const local = this.state.messages.filter((m) => m.pending || m.failed);
          this.set({ status: 'ready', messages: [...merge([], messages), ...local], hasMore });
          if (this.active) this.markRead();
        } else {
          this.set({
            messages: merge(this.state.messages, messages),
            hasMore,
            loadingOlder: false,
          });
        }
        return;
      }
      case 'chat.message': {
        const incoming = message.payload.message;
        if (request?.kind === 'send') {
          const local = this.state.messages.find((m) => m.clientId === request.clientId);
          if (local) {
            this.set({
              messages: sortById(
                this.state.messages.filter((m) => m.id !== local.id && m.id !== incoming.id),
                incoming,
              ),
            });
          } else this.add(incoming);
          // Your own message: everything before it is read too.
          this.set({ lastReadId: incoming.id, unread: 0 });
          return;
        }
        if (this.state.status === 'off') return;
        if (!this.add(incoming) || incoming.userId === this.selfId) return;
        if (this.active) this.markRead();
        else {
          this.set({ unread: this.state.unread + 1 });
          if (this.selfId !== null && incoming.mentions.includes(this.selfId)) {
            this.options.onMention?.(incoming);
          }
        }
        return;
      }
      case 'chat.edited': {
        const { messageId, text, editedAt, mentions } = message.payload;
        const current = this.state.messages.find((m) => m.id === messageId);
        if (current) this.replace(messageId, { ...current, text, editedAt, mentions });
        return;
      }
      case 'chat.deleted':
        this.set({
          messages: this.state.messages.filter((m) => m.id !== message.payload.messageId),
        });
        return;
      case 'error': {
        if (!request) return;
        if (request.kind === 'send') {
          const local = this.state.messages.find((m) => m.clientId === request.clientId);
          if (local) {
            this.replace(local.id, failedEntry(local, message.payload));
          }
        } else if (request.kind === 'page') {
          this.set({ status: 'ready', loadingOlder: false });
        } else if (request.kind !== 'read') {
          this.set({ error: message.payload });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Adds a message; false when it was already there. */
  private add(message: ChatMessage): boolean {
    if (this.state.messages.some((m) => m.id === message.id)) return false;
    this.set({ messages: sortById(this.state.messages, message) });
    return true;
  }

  private replace(id: string, entry: ChatEntry): void {
    this.set({
      messages: this.state.messages.map((m) => (m.id === id ? entry : m)),
    });
  }

  private markRead(): void {
    const newest = [...this.state.messages].reverse().find((m) => !m.pending && !m.failed);
    if (this.state.unread !== 0) this.set({ unread: 0 });
    if (!newest || newest.id === this.state.lastReadId) return;
    if (this.state.lastReadId !== null && seqOf(newest.id) <= seqOf(this.state.lastReadId)) return;
    const id = this.options.socket.request('chat.read', { messageId: newest.id });
    if (id !== null) this.requests.set(id, { kind: 'read' });
    this.set({ lastReadId: newest.id });
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** The entry as the room refused (or never answered) it: no longer pending. */
function failedEntry(entry: ChatEntry, error: ErrorPayload): ChatEntry {
  const out: ChatEntry = { ...entry, failed: error };
  delete out.pending;
  return out;
}

/** Confirmed messages in room order, then the local (pending or failed) ones. */
function sortById(messages: ChatEntry[], message: ChatMessage): ChatEntry[] {
  const confirmed = messages.filter((m) => !m.pending && !m.failed);
  const local = messages.filter((m) => m.pending || m.failed);
  const at = confirmed.findIndex((m) => seqOf(m.id) > seqOf(message.id));
  const next =
    at === -1
      ? [...confirmed, message]
      : [...confirmed.slice(0, at), message, ...confirmed.slice(at)];
  return [...next, ...local];
}

/** Adds a page of messages to the list, without duplicates, in room order. */
function merge(current: ChatEntry[], page: ChatMessage[]): ChatEntry[] {
  let out = current;
  for (const m of page) if (!out.some((x) => x.id === m.id)) out = sortById(out, m);
  return out;
}
