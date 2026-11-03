// SPDX-License-Identifier: AGPL-3.0-only
import { chatActivity, listRooms, listSpaces, recentStreams } from '@openlive/client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useInstances } from '../state.tsx';
import { loadServerSummary } from './load.ts';
import { nonEmpty, type ServerSummary, wasAway } from './model.ts';

// "What happened" on opening the app (or coming back to it) after being away: when the app goes
// to the background its time is saved; on return, if it was five minutes or more, each signed-in
// server is asked what it missed. The time is saved on the phone too, so a cold start after the
// system closed the app counts the same.

const KEY = 'openlive.lastSeen';
/** While the app is in front its time is kept fresh, so a closed app still knows when it left. */
const HEARTBEAT_MS = 60_000;

export function useAwaySummary(): { summary: ServerSummary[]; dismiss: () => void } {
  const { ready, instances, client } = useInstances();
  const [summary, setSummary] = useState<ServerSummary[]>([]);
  const lastSeen = useRef<number | null>(null);
  const loaded = useRef(false);
  // The latest instances, for the AppState handler.
  const latest = useRef({ instances, client });
  useEffect(() => {
    latest.current = { instances, client };
  });

  const save = useCallback((at: number) => {
    lastSeen.current = at;
    void AsyncStorage.setItem(KEY, String(at)).catch(() => undefined);
  }, []);

  const check = useCallback(async () => {
    const now = Date.now();
    const since = lastSeen.current;
    if (since === null || !wasAway(since, now)) {
      save(now);
      return;
    }
    save(now);
    const signedIn = latest.current.instances.filter((i) => i.user);
    const servers = await Promise.all(
      signedIn.map(async (instance) => {
        const api = await latest.current.client(instance.origin).catch(() => null);
        if (!api) return null;
        return loadServerSummary(
          instance.origin,
          instance.name,
          {
            spaces: () => listSpaces(api),
            rooms: (spaceId) => listRooms(api, spaceId),
            chat: (spaceId) => chatActivity(api, spaceId),
            streams: (spaceId, from) => recentStreams(api, spaceId, from),
          },
          since,
        );
      }),
    );
    setSummary(nonEmpty(servers.flatMap((s) => (s ? [s] : []))));
  }, [save]);

  // Cold start: the saved time, once the instances are known.
  useEffect(() => {
    if (!ready || loaded.current) return;
    loaded.current = true;
    void AsyncStorage.getItem(KEY)
      .then((raw) => {
        const at = raw === null ? NaN : Number(raw);
        lastSeen.current = Number.isFinite(at) ? at : null;
      })
      .catch(() => undefined)
      .then(check);
  }, [ready, check]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') save(Date.now());
      else if (state === 'active' && loaded.current) void check();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') save(Date.now());
    }, HEARTBEAT_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [check, save]);

  return { summary, dismiss: () => setSummary([]) };
}
