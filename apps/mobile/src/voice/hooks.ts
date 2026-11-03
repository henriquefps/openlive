// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CameraClientState,
  capabilitiesOf,
  type RoomState,
  type VoiceSessionsState,
} from '@openlive/client';
import type { RoomSettings } from '@openlive/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { MediaStreamTrack } from 'react-native-webrtc';
import { registerRoom, voiceSessions } from './host.ts';
import type { PhoneRoomSession, RoomLink } from './parts.ts';
import type { PhoneVoiceState } from './phone-voice.ts';

// The React side of the app's voice (host.ts): the room screen's session, held while the screen
// shows the room, and "the room I am in voice in" for the bar that follows the user around.

const none = () => () => undefined;
const nothing = () => null;

export interface RoomVoice {
  session: PhoneRoomSession;
  /** The voice session's own view of the room (its socket). */
  room: RoomState;
  /** The room has voice. */
  hasVoice: boolean;
  hasCamera: boolean;
  voice: PhoneVoiceState;
  camera: CameraClientState<MediaStreamTrack>;
  /** This phone is in voice in this room (joining or joined). */
  inVoice: boolean;
  join: () => void;
}

/**
 * The room screen's voice: the app's session for the room (the one the phone is in voice with, when
 * it is this room), held while the screen shows it. `settings` is the screen's own socket's, used
 * until this one's welcome arrives.
 */
export function useRoomVoice(
  roomId: string,
  link: RoomLink,
  settings: RoomSettings | null,
): RoomVoice {
  const session = useMemo(() => {
    registerRoom(roomId, link);
    return voiceSessions.get(roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, link.origin]);
  // The room's voice socket opens only for a room that has voice (the screen's own socket tells
  // first); a room the phone is in voice with stays held by the voice itself.
  const offered = settings !== null && capabilitiesOf(settings).voice;
  useEffect(() => (offered ? voiceSessions.view(session) : undefined), [session, offered]);
  useEffect(() => session.setHint(settings), [session, settings]);
  useEffect(() => session.describe(link.roomName, link));
  const { connection, voice, camera } = session.parts;
  const room = useSyncExternalStore(connection.subscribe, connection.getState);
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getState);
  const cameraState = useSyncExternalStore(camera.subscribe, camera.getState);
  const known = room.settings ?? settings;
  const c = capabilitiesOf(known);
  const hasVoice = known !== null && c.voice;
  return {
    session,
    room,
    hasVoice,
    hasCamera: hasVoice && c.camera,
    voice: voiceState,
    camera: cameraState as CameraClientState<MediaStreamTrack>,
    inVoice: voiceState.phase !== 'idle' || voiceState.preparing,
    join: () => voiceSessions.requestJoin(session),
  };
}

export function useVoiceSessionsState(): VoiceSessionsState<PhoneRoomSession> {
  return useSyncExternalStore(voiceSessions.subscribe, voiceSessions.getState);
}

export interface ActiveVoice {
  session: PhoneRoomSession;
  voice: PhoneVoiceState;
  link: RoomLink | null;
  name: string;
  /** The room's screen is open now. */
  viewed: boolean;
}

/** The room the phone is in voice in, with its live state; null while out of voice. */
export function useActiveVoice(): ActiveVoice | null {
  const { active, viewing } = useVoiceSessionsState();
  const voice = useSyncExternalStore(
    active?.parts.voice.subscribe ?? none,
    active?.parts.voice.getState ?? nothing,
  );
  const room = useSyncExternalStore(
    active?.parts.connection.subscribe ?? none,
    active?.parts.connection.getState ?? nothing,
  );
  if (!active || !voice || !room) return null;
  return {
    session: active,
    voice,
    link: active.link,
    name: room.room?.name ?? active.name,
    viewed: viewing.includes(active.roomId),
  };
}
