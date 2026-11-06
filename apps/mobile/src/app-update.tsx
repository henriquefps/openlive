// SPDX-License-Identifier: AGPL-3.0-only
import { useQueries } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { DISMISSED_KEY, parseManifest, pickUpdate, readDismissed } from './lib/app-update.ts';
import type { AvailableUpdate } from './lib/app-update.ts';
import { voicePrefsStore } from './voice/store.ts';
import { useInstances } from './state.tsx';

// The newer-Android-app banner: asks every signed-in instance for its Android manifest (at most
// once a day), and offers the highest version newer than the installed one. Any failure (signed
// out, not a member, nothing published, offline) is silently "no update info".

const DAY = 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getDismissed = () => {
  try {
    return readDismissed(voicePrefsStore.getItem(DISMISSED_KEY));
  } catch {
    return null;
  }
};

/** The update to offer on the Servers screen, and a way to dismiss that exact version. */
export function useAppUpdate(): { update: AvailableUpdate | null; dismiss: () => void } {
  const { instances, client } = useInstances();
  const enabled = Platform.OS === 'android';
  const signedIn = instances.filter((i) => i.user);
  const results = useQueries({
    queries: signedIn.map((i) => ({
      // Not under the cache's 'ol' root, so the persister never writes it to the phone.
      queryKey: ['ol-update', i.origin, i.user?.userId ?? '-', 'android-manifest'],
      queryFn: async (): Promise<unknown> => {
        try {
          const api = await client(i.origin);
          return api ? parseManifest(await api.get('/api/helper/android')) : null;
        } catch {
          return null;
        }
      },
      enabled,
      staleTime: DAY,
      gcTime: DAY,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });
  const dismissed = useSyncExternalStore(subscribe, getDismissed);
  const installed = Constants.expoConfig?.version ?? '';
  const offers = signedIn.map((i, n) => ({ origin: i.origin, manifest: results[n]?.data }));
  const update = enabled ? pickUpdate(installed, offers) : null;
  const dismiss = useCallback(() => {
    if (!update) return;
    voicePrefsStore.setItem(DISMISSED_KEY, update.version);
    for (const l of listeners) l();
  }, [update]);
  return { update: update && update.version !== dismissed ? update : null, dismiss };
}
