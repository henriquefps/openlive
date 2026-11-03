// SPDX-License-Identifier: AGPL-3.0-only
import { bearerToken, createApiClient, VoiceSessions } from '@openlive/client';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { hostOf } from '../lib/host.ts';
import { InstanceStore } from '../lib/storage.ts';
import {
  onNotificationAction,
  requestMicPermission,
  startVoiceSession,
  stopVoiceSession,
  voice as nativeVoice,
} from '../voice-native/index.ts';
import { createPhoneRoomSession, type PhoneParts, type RoomLink } from './parts.ts';
import type { PhoneCall } from './phone-voice.ts';
import { backgroundRules, type NetworkInfo, reconnectOnNetwork } from './rules.ts';

// The app's voice: one VoiceSessions for the whole app (packages/client voice/session.ts), so the
// voice outlives the room screen (leave the screen, the call goes on, as on Discord) and only one
// room is in voice at a time. The room screen and the voice bar read it through hooks.ts.

const store = new InstanceStore(SecureStore);

/** The phone's call, from voice-native: permission, service and notification, audio mode. */
export const phoneCall: PhoneCall = {
  requestMicPermission,
  startVoiceSession: (options) =>
    startVoiceSession({
      roomName: options.roomName,
      serverName: options.serverName,
      ...(options.serverAddress ? { serverAddress: options.serverAddress } : {}),
      muted: options.muted,
      microphone: options.microphone,
    }),
  stopVoiceSession,
  setNotificationMuted: (muted) => nativeVoice.setMuted(muted),
  onNotificationAction,
  onSessionEnded: (listener) => nativeVoice.onSessionEnded(() => listener()),
};

/** What the screen that opens a room's session says of it, until the session is created. */
const links = new Map<string, RoomLink>();

export const voiceSessions = new VoiceSessions<PhoneParts, RoomLink>((roomId) => {
  const link = links.get(roomId);
  if (!link) throw new Error(`no link registered for room ${roomId}`);
  const api = createApiClient({
    baseUrl: link.origin,
    auth: bearerToken(() => store.getToken(link.origin)),
  });
  const session = createPhoneRoomSession(api, roomId, phoneCall, () => {
    const now = session.link ?? link;
    return {
      roomName: session.name || now.roomName,
      serverName: now.serverName,
      serverAddress: hostOf(now.origin),
    };
  });
  session.link = link;
  return session;
});

/** The room screen tells where the room is before it asks for the session. */
export function registerRoom(roomId: string, link: RoomLink): void {
  links.set(roomId, link);
}

// Voice keeps its room socket and SFU sessions with the screen locked or another app in front
// (the foreground service holds the process); coming back to the front asks a socket that gave up
// waiting to try at once (rules.ts).
AppState.addEventListener('change', (appState) => {
  const active = voiceSessions.getState().active;
  if (!active) return;
  const actions = backgroundRules({
    appState,
    inVoice: true,
    reconnecting: active.parts.connection.getState().status === 'reconnecting',
    watching: false,
  });
  if (actions.reconnectNow) active.parts.connection.reconnect();
  if (actions.stopCamera) active.parts.camera.turnOff();
});

// Wi-Fi <-> cellular while in voice: try the room socket at once (the SFU session replaces itself
// when its connection fails, and voice publishes again), without leaving voice.
let lastNetwork: NetworkInfo | null = null;
Network.addNetworkStateListener((state) => {
  const next: NetworkInfo = {
    isConnected: state.isConnected === true,
    type: String(state.type ?? 'unknown'),
  };
  const active = voiceSessions.getState().active;
  if (reconnectOnNetwork(lastNetwork, next, active !== null) && active) {
    active.parts.connection.reconnect();
  }
  lastNetwork = next;
});
