// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@openlive/protocol';
import { canActOn } from '../api/permissions.ts';
import type { RoomConnection } from '../room/connection.ts';
import type { VoiceSignal } from './client.ts';

// The voice part of a room socket as the voice and camera clients and the voice screens use it,
// and what owners and admins may do to someone in voice (PROTOCOL 7.5, 7.7).

/** Owner and admin actions on someone in voice (PROTOCOL 7.5). */
export interface VoiceModeration {
  serverMute: (userId: string, muted: boolean) => void;
  kick: (userId: string) => void;
  /** Since 1.12: turn their camera off. */
  cameraOff: (userId: string) => void;
}

/** The room connection's voice channel, as the voice client drives it. */
export function roomVoiceSignal(connection: RoomConnection): VoiceSignal {
  return {
    getVoice: () => connection.getState().voice,
    subscribe: connection.subscribe,
    join: (state) => connection.joinVoice(state),
    leave: () => connection.leaveVoice(),
    setState: (state) => connection.setVoiceState(state),
  };
}

export function roomVoiceModeration(connection: RoomConnection): VoiceModeration {
  return {
    serverMute: (userId, muted) => connection.serverMute(userId, muted),
    kick: (userId) => connection.kickFromVoice(userId),
    cameraOff: (userId) => connection.cameraOff(userId),
  };
}

/** What the person menu of someone in voice offers the viewer. */
export interface PersonMenuAbilities {
  /** Server mute or unmute (everyone's microphone of that person closed by the room). */
  serverMute: boolean;
  /** Remove from voice. */
  kick: boolean;
  /** Turn their camera off: only while it is on. */
  cameraOff: boolean;
}

/**
 * The web's PersonMenu rule: the viewer must be allowed to moderate (`canModerate`, owner or
 * admin) and act on that person (owners on anyone else, admins on members and guests).
 */
export function personMenuAbilities(
  viewer: { userId: string; role: Role | null; canModerate: boolean },
  target: { userId: string; role: Role; camera: boolean },
): PersonMenuAbilities {
  const moderate = viewer.canModerate && canActOn(viewer.role, viewer.userId, target);
  return { serverMute: moderate, kick: moderate, cameraOff: moderate && target.camera };
}
