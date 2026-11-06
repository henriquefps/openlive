// SPDX-License-Identifier: AGPL-3.0-only
import {
  createSpace,
  joinRoomByCode,
  listDevices,
  listSessions,
  revokeDevice,
  revokeSession,
} from '@openlive/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys } from './lib/cache.ts';
import { signedOutKey, useCall, useScope } from './queries.ts';

// What the spaces list and the settings add on top of queries.ts: creating a space, joining a
// quick room by its code, and the sessions and paired helpers of the account (the web's
// SpacesPage, JoinPage and SettingsPage). Sessions and devices are read when the screen opens
// and are never saved on the phone (lib/cache.ts).

/** Creates a space; the list of spaces is read again before the mutation settles. */
export function useCreateSpace(origin: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) => call((api) => createSpace(api, input)),
    onSuccess: async () => {
      if (scope) await queryClient.invalidateQueries({ queryKey: keys(scope).spaces() });
    },
  });
}

/** Joins a quick room by its code; a member's spaces may change, so they are read again. */
export function useJoinByCode(origin: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => call((api) => joinRoomByCode(api, code)),
    onSuccess: async () => {
      if (scope) await queryClient.invalidateQueries({ queryKey: keys(scope).spaces() });
    },
  });
}

export function useSessions(origin: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).sessions() : signedOutKey(origin),
    queryFn: async () => (await call(listSessions)).sessions,
    enabled: scope !== null && enabled,
    staleTime: 0,
  });
}

export function useRevokeSession(origin: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => call((api) => revokeSession(api, sessionId)),
    onSuccess: async () => {
      if (scope) await queryClient.invalidateQueries({ queryKey: keys(scope).sessions() });
    },
  });
}

export function useDevices(origin: string, enabled = true) {
  const scope = useScope(origin);
  const call = useCall(origin);
  return useQuery({
    queryKey: scope ? keys(scope).devices() : signedOutKey(origin),
    queryFn: async () => (await call(listDevices)).devices,
    enabled: scope !== null && enabled,
    staleTime: 0,
  });
}

export function useRevokeDevice(origin: string) {
  const scope = useScope(origin);
  const call = useCall(origin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => call((api) => revokeDevice(api, deviceId)),
    onSuccess: async () => {
      if (scope) await queryClient.invalidateQueries({ queryKey: keys(scope).devices() });
    },
  });
}
