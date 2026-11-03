// SPDX-License-Identifier: AGPL-3.0-only
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CameraPrefsStorage, PrefsStorage } from '@openlive/client';

// The voice and camera settings (push-to-talk, each person's volume, the front or back camera) on
// the phone. The shared clients read them synchronously (localStorage on the web), so the values
// are loaded from AsyncStorage once at start-up and written through.

const PREFIX = 'openlive.';
const cache = new Map<string, string>();

/** Resolves once the saved values are in memory. */
export const prefsReady: Promise<void> = AsyncStorage.getAllKeys()
  .then((keys) => AsyncStorage.multiGet(keys.filter((k) => k.startsWith(PREFIX))))
  .then((pairs) => {
    for (const [key, value] of pairs) if (value !== null) cache.set(key, value);
  })
  .catch(() => undefined);

export const voicePrefsStore: PrefsStorage & CameraPrefsStorage = {
  getItem: (key) => cache.get(key) ?? null,
  setItem: (key, value) => {
    cache.set(key, value);
    void AsyncStorage.setItem(key, value).catch(() => undefined);
  },
};
