// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ChatMessage,
  Member,
  RoomInfo,
  RoomPresence,
  RoomSettings,
  StreamInfo,
  ViewersPayload,
  You,
} from '@openlive/protocol';
import type { DehydratedState, QueryClient, QueryKey } from '@tanstack/react-query';

// The rules of the app's data cache (TanStack Query, persisted on the phone), without React or
// React Native so they are tested with Vitest:
//
// - every key starts with ['ol', server origin, signed-in user id, kind, ...ids], so two servers
//   or two users never share an entry, and one server's entries are found (and wiped) by prefix;
// - what is written to the phone: only successful queries of this app, no mutations, no invite
//   previews, chat only for rooms that keep their messages, capped and not older than a week;
// - app tokens never come near the cache: they stay in secure storage (lib/storage.ts).

const ROOT = 'ol';

/** The longest the saved cache is used on a cold start, and the longest a saved message lives. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Messages kept per room, in memory and on the phone (the newest). */
export const CHAT_KEEP = 100;

/** The cache format plus the app version: a new app version starts from an empty cache. */
export function cacheBuster(appVersion: string): string {
  return `v1:${appVersion}`;
}

export interface Scope {
  origin: string;
  userId: string;
}

/** The key of every cached thing of one server and signed-in user. */
export function keys({ origin, userId }: Scope) {
  const base = [ROOT, origin, userId] as const;
  return {
    /** The caller's profile: name, photo and where the photo comes from (GET /api/me). */
    me: () => [...base, 'me'] as const,
    spaces: () => [...base, 'spaces'] as const,
    rooms: (spaceId: string) => [...base, 'rooms', spaceId] as const,
    unread: (spaceId: string) => [...base, 'unread', spaceId] as const,
    invite: (token: string) => [...base, 'invite', token] as const,
    /** The space socket's last snapshot. */
    presence: (spaceId: string) => [...base, 'presence', spaceId] as const,
    /** The room socket's last welcome, kept up to date by its events. */
    room: (roomId: string) => [...base, 'room', roomId] as const,
    /** The newest chat messages of a room. */
    chat: (roomId: string) => [...base, 'chat', roomId] as const,
  };
}

/** Every key of a server (any user), or of one user of it. */
const prefix = (origin: string, userId?: string): QueryKey =>
  userId === undefined ? [ROOT, origin] : [ROOT, origin, userId];

/**
 * Forgets what is cached for a server: after sign out, a revoked or expired session (401) and
 * when the server is removed. With `keepUserId`, only other users' entries go (a sign-in as
 * someone else than the last time). In-flight requests are cancelled first so that none writes
 * the entry back.
 */
export async function wipeServer(
  client: QueryClient,
  origin: string,
  keepUserId?: string,
): Promise<void> {
  const filters = {
    queryKey: prefix(origin),
    predicate: (query: { queryKey: QueryKey }) =>
      keepUserId === undefined || query.queryKey[2] !== keepUserId,
  };
  await client.cancelQueries(filters);
  client.removeQueries(filters);
}

/** Drops every entry whose server or user is not a signed-in one (restored from an old save). */
export function pruneUnknown(client: QueryClient, signedIn: readonly Scope[]): void {
  client.removeQueries({
    predicate: (query) => {
      const [root, origin, userId] = query.queryKey;
      if (root !== ROOT) return false;
      return !signedIn.some((s) => s.origin === origin && s.userId === userId);
    },
  });
}

// What the sockets leave in the cache. These entries are set by the app (setQueryData), never
// fetched; the REST ones (spaces, rooms, unread) are plain query results.

export interface PresenceSnapshot {
  rooms: Record<string, RoomPresence>;
  savedAt: number;
}

export interface RoomSnapshot {
  you: You;
  room: RoomInfo | null;
  settings: RoomSettings | null;
  members: Member[];
  streams: StreamInfo[];
  viewers: Record<string, ViewersPayload>;
  savedAt: number;
}

export interface ChatSnapshot {
  /** Confirmed messages only, oldest first. */
  messages: ChatMessage[];
  hasMore: boolean;
  lastReadId: string | null;
  /** The room's retention when saved (0: the room keeps nothing); undefined: not known. */
  retentionDays: number | undefined;
  /** A quick room's chat ends with the room. */
  quick: boolean;
  savedAt: number;
}

/** Whether a room's chat may be written to the phone: it keeps its messages for some days. */
export function chatMayPersist(snapshot: Pick<ChatSnapshot, 'retentionDays' | 'quick'>): boolean {
  return !snapshot.quick && snapshot.retentionDays !== undefined && snapshot.retentionDays > 0;
}

/** The newest `CHAT_KEEP` messages; `hasMore` once any was left out. */
export function capChat(snapshot: ChatSnapshot): ChatSnapshot {
  if (snapshot.messages.length <= CHAT_KEEP) return snapshot;
  return {
    ...snapshot,
    messages: snapshot.messages.slice(-CHAT_KEEP),
    hasMore: true,
  };
}

/** The chat as it may be saved on the phone, or null when it must not be. */
export function persistableChat(snapshot: ChatSnapshot, now: number): ChatSnapshot | null {
  if (!chatMayPersist(snapshot)) return null;
  const recent = snapshot.messages.filter((m) => m.createdAt >= now - MAX_AGE_MS);
  if (recent.length === 0) return null;
  const capped = capChat({ ...snapshot, messages: recent });
  return recent.length < snapshot.messages.length ? { ...capped, hasMore: true } : capped;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The kinds that are never written to the phone (an invite token is a secret to share). */
const NEVER_SAVED = new Set(['invite']);

/**
 * What goes to (or comes back from) the phone's storage: successful queries of this app that are
 * young enough, with chat reduced to what `persistableChat` allows. Mutations never go.
 */
export function sanitizeDehydrated(state: DehydratedState, now: number): DehydratedState {
  const queries: DehydratedState['queries'] = [];
  for (const query of state.queries) {
    const [root, origin, userId, kind] = query.queryKey;
    if (root !== ROOT || typeof origin !== 'string' || typeof userId !== 'string') continue;
    if (query.state.status !== 'success' || query.state.data === undefined) continue;
    if (typeof kind !== 'string' || NEVER_SAVED.has(kind)) continue;
    if (now - query.state.dataUpdatedAt > MAX_AGE_MS) continue;
    if (kind === 'chat') {
      const data = query.state.data;
      if (!isRecord(data) || !Array.isArray(data['messages'])) continue;
      const kept = persistableChat(data as unknown as ChatSnapshot, now);
      if (!kept) continue;
      queries.push({ ...query, state: { ...query.state, data: kept } });
      continue;
    }
    queries.push(query);
  }
  return { mutations: [], queries };
}
