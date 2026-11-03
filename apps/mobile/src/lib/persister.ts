// SPDX-License-Identifier: AGPL-3.0-only
import { dehydrate, type QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { sanitizeDehydrated } from './cache.ts';

// The query cache on the phone: one JSON entry in a key-value store (AsyncStorage in the app, a
// map in the tests), rewritten at most once per `throttleMs` and always through
// `sanitizeDehydrated`, so what the privacy rules forbid never reaches the disk.

/** The subset of AsyncStorage this module uses. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const CACHE_KEY = 'openlive.query-cache.v1';

export interface CachePersister extends Persister {
  /** Writes the client's cache now (after a sign out: the disk must not wait a second). */
  flush(client: QueryClient, buster: string): Promise<void>;
}

export function createCachePersister(
  store: KeyValueStore,
  options: { throttleMs?: number; now?: () => number } = {},
): CachePersister {
  const throttleMs = options.throttleMs ?? 1000;
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: PersistedClient | null = null;

  const write = async (client: PersistedClient): Promise<void> => {
    const clean: PersistedClient = {
      ...client,
      clientState: sanitizeDehydrated(client.clientState, now()),
    };
    await store.setItem(CACHE_KEY, JSON.stringify(clean));
  };

  return {
    persistClient(client) {
      latest = client;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const next = latest;
        latest = null;
        if (next) void write(next).catch(() => undefined);
      }, throttleMs);
    },
    async restoreClient() {
      const raw = await store.getItem(CACHE_KEY).catch(() => null);
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as PersistedClient;
        return {
          ...parsed,
          clientState: sanitizeDehydrated(parsed.clientState, now()),
        };
      } catch {
        // A broken save is no cache.
        await store.removeItem(CACHE_KEY).catch(() => undefined);
        return undefined;
      }
    },
    async removeClient() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latest = null;
      await store.removeItem(CACHE_KEY);
    },
    async flush(client, buster) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latest = null;
      await write({ timestamp: now(), buster, clientState: dehydrate(client) });
    },
  };
}
