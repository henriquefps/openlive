// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomSettings } from '@openlive/protocol';
import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { capabilitiesOf } from '../lib/capabilities.ts';
import { fakeMediaEnabled } from '../lib/flags.ts';
import { RoomConnection, type RoomState, roomSocketUrl, TAB_ID } from '../room/connection.ts';
import { type RoomSocketApi, roomSocketApi } from '../room/socket-api.ts';
import { httpRtcApi } from '../rtc/api.ts';
import { RtcSession, type SessionStatus } from '../rtc/session.ts';
import { httpVoiceApi } from './api.ts';
import { AudioPlayback } from './audio.ts';
import { httpCameraApi } from './camera-api.ts';
import { sessionCameraMedia } from './camera-media.ts';
import {
  CameraClient,
  type CameraClientState,
  DEFAULT_CAMERA_PREFS,
  loadCameraPrefs,
} from './camera.ts';
import { type DevicesLike, VoiceClient, type VoiceClientState } from './client.ts';
import { LevelMonitor } from './levels.ts';
import { sessionVoiceMedia } from './media.ts';
import { NetworkMeter } from './network.ts';
import { DEFAULT_PREFS, loadPrefs } from './prefs.ts';
import {
  type RoomLink,
  RoomSession,
  type RoomSessionParts,
  VoiceSessions,
  type VoiceSessionsState,
} from './session.ts';

// The React side of the app's voice session (session.ts): the browser parts of a room session,
// the shell's registry in a context, and the hooks of the room page and the "Voice connected"
// panel.

/** A room's parts in the browser: the room socket, its SFU session, the voice and camera clients. */
export type AppParts = RoomSessionParts<RoomConnection, RtcSession, VoiceClient, CameraClient> & {
  socket: RoomSocketApi;
};
export type AppRoomSession = RoomSession<AppParts>;
export type AppVoiceSessions = VoiceSessions<AppParts>;

export const IDLE_VOICE: VoiceClientState = {
  phase: 'idle',
  muted: false,
  deafened: false,
  serverMuted: false,
  pushToTalk: DEFAULT_PREFS.pushToTalk,
  pushToTalkKey: DEFAULT_PREFS.pushToTalkKey,
  pttPressed: false,
  transmitting: false,
  micError: null,
  error: null,
  removed: null,
  speaking: {},
  volumes: {},
  inputs: [],
  outputs: [],
  inputId: '',
  outputId: '',
  canPickOutput: false,
  voiceSinkId: null,
};

export const CAMERA_OFF: CameraClientState = {
  phase: 'off',
  error: null,
  refused: null,
  stopped: null,
  preview: null,
  facing: DEFAULT_CAMERA_PREFS.facing,
  inputs: [],
  inputId: '',
  remote: {},
  enlarged: null,
  high: [],
  network: 'good',
};

function mediaDevices(): DevicesLike | null {
  return typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null;
}

/** A room's session with the browser's socket, SFU session, devices and speakers. */
export function createRoomSession(roomId: string): AppRoomSession {
  const connection = new RoomConnection({ url: roomSocketUrl(roomId), tabId: TAB_ID });
  const socket = roomSocketApi(connection);
  const rtc = new RtcSession({ api: httpRtcApi(roomId) });
  const voice = new VoiceClient({
    signal: socket.voice,
    media: sessionVoiceMedia(rtc, httpVoiceApi(roomId)),
    devices: mediaDevices(),
    output: new AudioPlayback(),
    createMonitor: (onChange) => new LevelMonitor(onChange),
    keys: typeof window === 'undefined' ? null : window,
    prefs: loadPrefs(),
  });
  const camera = new CameraClient({
    signal: socket.voice,
    media: sessionCameraMedia(rtc, httpCameraApi(roomId)),
    devices: mediaDevices(),
    prefs: loadCameraPrefs(),
  });
  return new RoomSession({
    roomId,
    parts: { connection, rtc, voice, camera, signal: socket.voice, socket },
    fake: fakeMediaEnabled(),
    window: typeof window === 'undefined' ? null : window,
    createMeter: () => new NetworkMeter(),
  });
}

export const createVoiceSessions = (): AppVoiceSessions => new VoiceSessions(createRoomSession);

export const VoiceSessionsContext = createContext<AppVoiceSessions | null>(null);

/** The shell's sessions; a page rendered without the shell gets its own. */
export function useVoiceSessions(): AppVoiceSessions {
  const shell = use(VoiceSessionsContext);
  const [own] = useState(() => (shell ? null : createVoiceSessions()));
  useEffect(() => (own ? () => own.dispose() : undefined), [own]);
  return shell ?? (own as AppVoiceSessions);
}

export function useVoiceSessionsState(): VoiceSessionsState<AppRoomSession> {
  const sessions = useVoiceSessions();
  return useSyncExternalStore(sessions.subscribe, sessions.getState);
}

export interface RoomSessionView {
  session: AppRoomSession;
  state: RoomState;
  rtcStatus: SessionStatus;
  /** The voice client while the room has voice. */
  voice: { client: VoiceClient | null; state: VoiceClientState };
  /** The camera client while the room has cameras. */
  camera: { client: CameraClient | null; state: CameraClientState };
  /** Join voice here; asks first while in voice in another room. */
  joinVoice: () => void;
}

/**
 * The room page's session: the one the app is in voice with when it is this room (nothing opened
 * twice), else a new one, held while the page shows it. `hint` is the page's REST answer, used
 * until the socket says what the room has.
 */
export function useRoomSession(
  roomId: string,
  hint: { settings: RoomSettings | null; name: string | null; link: RoomLink | null },
): RoomSessionView {
  const sessions = useVoiceSessions();
  const session = useMemo(() => sessions.get(roomId), [sessions, roomId]);
  useEffect(() => sessions.view(session), [sessions, session]);
  useEffect(() => session.setHint(hint.settings), [session, hint.settings]);
  useEffect(() => session.describe(hint.name, hint.link));
  const { connection, rtc, voice, camera } = session.parts;
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const rtcStatus = useSyncExternalStore(rtc.subscribe, rtc.getStatus);
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getState);
  const cameraState = useSyncExternalStore(camera.subscribe, camera.getState);
  const known = state.settings ?? hint.settings;
  const c = capabilitiesOf(known);
  const hasVoice = known !== null && c.voice;
  const hasCamera = hasVoice && c.camera;
  return {
    session,
    state,
    rtcStatus,
    voice: { client: hasVoice ? voice : null, state: hasVoice ? voiceState : IDLE_VOICE },
    camera: { client: hasCamera ? camera : null, state: hasCamera ? cameraState : CAMERA_OFF },
    joinVoice: () => sessions.requestJoin(session),
  };
}

export interface ActiveVoice {
  session: AppRoomSession;
  room: RoomState;
  voice: VoiceClientState;
  camera: CameraClientState | null;
  /** A page shows the room now. */
  viewed: boolean;
}

/** The room this tab is in voice in, with its live state; null while out of voice. */
export function useActiveVoice(): ActiveVoice | null {
  const sessions = useVoiceSessions();
  const { active, viewing } = useSyncExternalStore(sessions.subscribe, sessions.getState);
  const noop = useMemo(() => ({ subscribe: () => () => undefined, get: () => null }), []);
  const room = useSyncExternalStore(
    active?.parts.connection.subscribe ?? noop.subscribe,
    active?.parts.connection.getState ?? noop.get,
  );
  const voice = useSyncExternalStore(
    active?.parts.voice.subscribe ?? noop.subscribe,
    active?.parts.voice.getState ?? noop.get,
  );
  const camera = useSyncExternalStore(
    active?.parts.camera.subscribe ?? noop.subscribe,
    active?.parts.camera.getState ?? noop.get,
  );
  if (!active || !room || !voice) return null;
  const c = capabilitiesOf(active.settings);
  return {
    session: active,
    room,
    voice,
    camera: c.voice && c.camera ? camera : null,
    viewed: viewing.includes(active.roomId),
  };
}
