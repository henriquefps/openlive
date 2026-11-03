// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ApiClient,
  CameraClient,
  createCameraApi,
  createVoiceApi,
  loadCameraPrefs,
  loadPersonVolume,
  loadPrefs,
  NetworkMeter,
  RoomConnection,
  type RoomSessionParts,
  RoomSession,
  roomVoiceModeration,
  roomVoiceSignal,
  SampledLevelMonitor,
  savePersonVolume,
  savePrefs,
  sessionCameraMedia,
  sessionVoiceMedia,
  socketPaths,
  ticketSocketUrl,
  VoiceClient,
  type VoiceModeration,
  type DevicesLike,
} from '@openlive/client';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { mediaDevices, type MediaStreamTrack } from 'react-native-webrtc';
import { helloClientVersion } from '../lib/client-version.ts';
import { createSession, type RnSession } from '../player/rtc.ts';
import { StatsLevelHub } from './levels.ts';
import { PhoneVoiceOutput } from './output.ts';
import { PhoneVoice, type PhoneCall } from './phone-voice.ts';
import { voicePrefsStore } from './store.ts';

// A room's voice session on the phone: its own room socket (a second "tab" of the app, as the web
// has when the stream is open in one and the voice in another), the room's SFU session, and the
// shared voice and camera clients with react-native-webrtc under them. The phone-side call
// (foreground service, notification, audio mode) is PhoneVoice's.

export type PhoneParts = RoomSessionParts<
  RoomConnection,
  RnSession,
  PhoneVoice<MediaStreamTrack>,
  CameraClient<MediaStreamTrack>
> & { moderation: VoiceModeration; client: VoiceClient<MediaStreamTrack> };

/** Where the room is and who holds the session's link: for the notification and the way back. */
export interface RoomLink {
  origin: string;
  spaceId: string;
  roomName: string;
  serverName: string;
}

export type PhoneRoomSession = RoomSession<PhoneParts, RoomLink>;

const clientVersion = helloClientVersion(Constants.expoConfig?.version);

const devices = (): DevicesLike<MediaStreamTrack> =>
  mediaDevices as unknown as DevicesLike<MediaStreamTrack>;

export function createPhoneRoomSession(
  api: ApiClient,
  roomId: string,
  call: PhoneCall,
  describe: () => { roomName: string; serverName: string; serverAddress?: string },
): PhoneRoomSession {
  const connection = new RoomConnection({
    url: ticketSocketUrl(api, socketPaths.room(roomId)),
    tabId: Crypto.randomUUID(),
    clientVersion,
  });
  const signal = roomVoiceSignal(connection);
  const rtc = createSession(api, roomId);
  const hub = new StatsLevelHub(rtc);
  const client = new VoiceClient<MediaStreamTrack>({
    signal,
    media: sessionVoiceMedia(rtc, createVoiceApi(api, roomId)),
    devices: devices(),
    output: new PhoneVoiceOutput<MediaStreamTrack>((track) => ({
      setVolume: (volume) =>
        (track as unknown as { _setVolume(volume: number): void })._setVolume(volume),
    })),
    createMonitor: (onChange) =>
      new SampledLevelMonitor<MediaStreamTrack>({
        onChange,
        open: (track) => hub.open(track.id),
      }),
    keys: null,
    prefs: loadPrefs(voicePrefsStore),
    savePrefs: (prefs) => savePrefs(prefs, voicePrefsStore),
    loadVolume: (userId) => loadPersonVolume(userId, voicePrefsStore),
    saveVolume: (userId, volume) => savePersonVolume(userId, volume, voicePrefsStore),
  });
  const camera = new CameraClient<MediaStreamTrack>({
    signal,
    media: sessionCameraMedia(rtc, createCameraApi(api, roomId)),
    devices: devices(),
    prefs: loadCameraPrefs(voicePrefsStore),
    savePrefs: (prefs) => voicePrefsStore.setItem('openlive.camera', JSON.stringify(prefs)),
  });
  const voice = new PhoneVoice<MediaStreamTrack>({ client, signal, call, describe });
  return new RoomSession<PhoneParts, RoomLink>({
    roomId,
    parts: {
      connection,
      rtc,
      voice,
      camera,
      signal,
      moderation: roomVoiceModeration(connection),
      client,
    },
    fake: false,
    window: null,
    createMeter: () => new NetworkMeter(),
    // The player opens its own SFU session when a stream is watched; this one is voice's.
    rtc: 'voice',
  });
}
