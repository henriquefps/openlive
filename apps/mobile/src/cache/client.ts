// SPDX-License-Identifier: AGPL-3.0-only
import AsyncStorage from '@react-native-async-storage/async-storage';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Network from 'expo-network';
import { AppState } from 'react-native';
import { ApiError } from '../lib/api.ts';
import { cacheBuster, MAX_AGE_MS, wipeServer } from '../lib/cache.ts';
import { createCachePersister } from '../lib/persister.ts';

// The app's one QueryClient and where it is saved. AsyncStorage (not MMKV): it is the storage
// Expo SDK 58 bundles and autolinks (no extra native build step), the cache is one small JSON
// entry written at most once a second, and reading it once at start is all a cold start needs.
// MMKV would only be faster at things this cache does not do.

export const BUSTER = cacheBuster(Constants.expoConfig?.version ?? '0.0.0');

/** Nothing retries a request the server answered "no" to; a lost connection retries twice. */
function retry(count: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return count < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Kept as long as it may be saved, so a screen visited yesterday opens with its data.
      gcTime: MAX_AGE_MS,
      staleTime: 30_000,
      retry,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  },
});

export const persister = createCachePersister(AsyncStorage);

/** Forgets a server's cache, in memory and on the phone, before the call returns. */
export async function wipeServerCache(origin: string, keepUserId?: string): Promise<void> {
  await wipeServer(queryClient, origin, keepUserId);
  await persister.flush(queryClient, BUSTER).catch(() => undefined);
}

let wired = false;

/** The app in front counts as "focused" and the network state as "online" for TanStack Query. */
export function wireQueryEnvironment(): void {
  if (wired) return;
  wired = true;
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state) =>
      handleFocus(state === 'active'),
    );
    return () => subscription.remove();
  });
  onlineManager.setEventListener((setOnline) => {
    const online = (state: Network.NetworkState) =>
      state.isConnected !== false && state.isInternetReachable !== false;
    void Network.getNetworkStateAsync().then((state) => setOnline(online(state)));
    const subscription = Network.addNetworkStateListener((state) => setOnline(online(state)));
    return () => subscription.remove();
  });
}
