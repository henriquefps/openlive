// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatMessage } from '@openlive/protocol';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  CHAT_KEEP,
  type ChatSnapshot,
  cacheBuster,
  chatMayPersist,
  keys,
  MAX_AGE_MS,
  persistableChat,
  pruneUnknown,
  sanitizeDehydrated,
  wipeServer,
} from '../src/lib/cache.ts';
import { CACHE_KEY, createCachePersister, type KeyValueStore } from '../src/lib/persister.ts';

const A = 'https://a.example.com';
const B = 'https://b.example.org';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const message = (n: number, createdAt = NOW - n): ChatMessage => ({
  id: `m_${n}`,
  userId: 'u1',
  authorName: 'Ana',
  text: `secret ${n}`,
  createdAt,
  mentions: [],
});

const chat = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  messages: [message(1), message(2)],
  hasMore: false,
  lastReadId: null,
  retentionDays: 30,
  quick: false,
  savedAt: NOW,
  ...over,
});

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

function filled() {
  const client = new QueryClient();
  const a1 = keys({ origin: A, userId: 'u1' });
  const a2 = keys({ origin: A, userId: 'u2' });
  const b1 = keys({ origin: B, userId: 'u1' });
  client.setQueryData(a1.spaces(), [{ id: 's1' }], { updatedAt: NOW });
  client.setQueryData(a2.spaces(), [{ id: 's2' }], { updatedAt: NOW });
  client.setQueryData(b1.spaces(), [{ id: 's3' }], { updatedAt: NOW });
  client.setQueryData(a1.chat('r1'), chat(), { updatedAt: NOW });
  return { client, a1, a2, b1 };
}

describe('keys', () => {
  it('differ per server and per user, and start with the server', () => {
    const a1 = keys({ origin: A, userId: 'u1' }).spaces();
    expect(a1).not.toEqual(keys({ origin: B, userId: 'u1' }).spaces());
    expect(a1).not.toEqual(keys({ origin: A, userId: 'u2' }).spaces());
    expect(a1.slice(0, 3)).toEqual(['ol', A, 'u1']);
  });

  it('keep the same id of two kinds apart', () => {
    const k = keys({ origin: A, userId: 'u1' });
    expect(k.room('x')).not.toEqual(k.chat('x'));
    expect(k.rooms('x')).not.toEqual(k.unread('x'));
  });

  it('the buster follows the app version', () => {
    expect(cacheBuster('0.1.0')).not.toBe(cacheBuster('0.2.0'));
  });
});

describe('wipeServer', () => {
  it('forgets one server and leaves the others', async () => {
    const { client, a1, a2, b1 } = filled();
    await wipeServer(client, A);
    expect(client.getQueryData(a1.spaces())).toBeUndefined();
    expect(client.getQueryData(a1.chat('r1'))).toBeUndefined();
    expect(client.getQueryData(a2.spaces())).toBeUndefined();
    expect(client.getQueryData(b1.spaces())).toEqual([{ id: 's3' }]);
  });

  it('keeps the signed-in user when asked to drop only the others', async () => {
    const { client, a1, a2 } = filled();
    await wipeServer(client, A, 'u1');
    expect(client.getQueryData(a1.spaces())).toBeDefined();
    expect(client.getQueryData(a2.spaces())).toBeUndefined();
  });

  it('cancels a request in flight so it cannot write the entry back', async () => {
    const client = new QueryClient();
    const key = keys({ origin: A, userId: 'u1' }).spaces();
    let finish: (v: string) => void = () => undefined;
    const pending = client
      .fetchQuery({ queryKey: key, queryFn: () => new Promise<string>((r) => (finish = r)) })
      .catch(() => undefined);
    await wipeServer(client, A);
    finish('late');
    await pending;
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('reaches the disk once flushed', async () => {
    const { client } = filled();
    const store = memory();
    const persister = createCachePersister(store, { now: () => NOW });
    await persister.flush(client, 'v1:x');
    expect(store.data.get(CACHE_KEY)).toContain('"s3"');
    await wipeServer(client, A);
    await persister.flush(client, 'v1:x');
    const saved = store.data.get(CACHE_KEY) ?? '';
    expect(saved).not.toContain('"s1"');
    expect(saved).not.toContain('secret');
    expect(saved).toContain('"s3"');
  });
});

describe('pruneUnknown', () => {
  it('drops entries of servers or users that are not signed in', () => {
    const { client, a1, a2, b1 } = filled();
    pruneUnknown(client, [{ origin: A, userId: 'u1' }]);
    expect(client.getQueryData(a1.spaces())).toBeDefined();
    expect(client.getQueryData(a2.spaces())).toBeUndefined();
    expect(client.getQueryData(b1.spaces())).toBeUndefined();
  });
});

describe('chat persistence', () => {
  it('never persists a room that keeps nothing', () => {
    expect(chatMayPersist({ retentionDays: 0, quick: false })).toBe(false);
    expect(persistableChat(chat({ retentionDays: 0 }), NOW)).toBeNull();
  });

  it('never persists a quick room or one whose retention is unknown', () => {
    expect(persistableChat(chat({ quick: true }), NOW)).toBeNull();
    expect(persistableChat(chat({ retentionDays: undefined }), NOW)).toBeNull();
  });

  it('keeps the newest 100 messages and says there are more', () => {
    const many = Array.from({ length: 150 }, (_, i) => message(i + 1, NOW - (150 - i)));
    const kept = persistableChat(chat({ messages: many }), NOW);
    expect(kept?.messages).toHaveLength(CHAT_KEEP);
    expect(kept?.messages.at(-1)?.id).toBe('m_150');
    expect(kept?.messages[0]?.id).toBe('m_51');
    expect(kept?.hasMore).toBe(true);
  });

  it('drops messages older than seven days, and the chat when none is left', () => {
    const old = message(1, NOW - MAX_AGE_MS - DAY);
    const fresh = message(2, NOW - DAY);
    expect(persistableChat(chat({ messages: [old, fresh] }), NOW)?.messages).toEqual([fresh]);
    expect(persistableChat(chat({ messages: [old] }), NOW)).toBeNull();
  });

  it('is applied when saving and when restoring', async () => {
    const client = new QueryClient();
    const k = keys({ origin: A, userId: 'u1' });
    client.setQueryData(k.chat('none'), chat({ retentionDays: 0 }), { updatedAt: NOW });
    client.setQueryData(k.chat('kept'), chat(), { updatedAt: NOW });
    client.setQueryData(k.invite('tok'), { spaceName: 'x' }, { updatedAt: NOW });
    const store = memory();
    const persister = createCachePersister(store, { now: () => NOW });
    await persister.flush(client, 'v1:x');
    const raw = store.data.get(CACHE_KEY) ?? '';
    expect(raw).not.toContain('"none"');
    expect(raw).not.toContain('tok');
    expect(raw).toContain('secret 1');
    // A save from before the rules (or tampered) is cleaned on the way back.
    store.data.set(
      CACHE_KEY,
      JSON.stringify({
        timestamp: NOW,
        buster: 'v1:x',
        clientState: dehydrate(client),
      }),
    );
    const restored = await persister.restoreClient();
    const restoredKeys = restored?.clientState.queries.map((q) => q.queryKey[4]);
    expect(restoredKeys).toEqual(['kept']);
  });

  it('never saves mutations, errors or stale-aged entries', () => {
    const client = new QueryClient();
    const k = keys({ origin: A, userId: 'u1' });
    client.setQueryData(k.spaces(), [1], { updatedAt: NOW - MAX_AGE_MS - 1 });
    client.setQueryData(k.rooms('s'), [2], { updatedAt: NOW });
    const state = sanitizeDehydrated(
      { ...dehydrate(client), mutations: [{ mutationKey: ['x'] } as never] },
      NOW,
    );
    expect(state.mutations).toEqual([]);
    expect(state.queries.map((q) => q.queryKey[3])).toEqual(['rooms']);
  });

  it('does not write tokens: only query data is saved', async () => {
    const { client } = filled();
    const store = memory();
    await createCachePersister(store, { now: () => NOW }).flush(client, 'v1:x');
    expect(store.data.get(CACHE_KEY)).not.toMatch(/token/i);
  });
});
