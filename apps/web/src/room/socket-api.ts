// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatSocket } from '../chat/client.ts';
import { type PointerSocket, pointerSocket } from '../pointer/socket.ts';
import type { VoiceSignal } from '../voice/client.ts';
import type { RoomConnection } from './connection.ts';

/** What the watch view asks of the room socket: viewer slots and the queue (PROTOCOL 7.3). */
export interface WatchActions {
  watch: (streamId: string) => void;
  unwatch: (streamId: string) => void;
  joinQueue: (streamId: string) => void;
  leaveQueue: (streamId: string) => void;
  acceptOffer: (streamId: string) => void;
}

/** Owner and admin actions on someone in voice (PROTOCOL 7.5). */
export interface VoiceModeration {
  serverMute: (userId: string, muted: boolean) => void;
  kick: (userId: string) => void;
  /** Since 1.12: turn their camera off. */
  cameraOff: (userId: string) => void;
}

/** The room socket as the room page's parts use it. */
export interface RoomSocketApi {
  actions: WatchActions;
  voice: VoiceSignal;
  moderation: VoiceModeration;
  chat: ChatSocket;
  /** Visual pointer pings (PROTOCOL 7.9). */
  pointer: PointerSocket;
}

/**
 * The room socket's features for the page: the watch view, voice and its moderation, the chat.
 * The connection itself belongs to the room's session (voice/session.ts), which outlives the page
 * while in voice.
 */
export function roomSocketApi(connection: RoomConnection): RoomSocketApi {
  return {
    actions: {
      watch: (id) => connection.watch(id),
      unwatch: (id) => connection.unwatch(id),
      joinQueue: (id) => connection.joinQueue(id),
      leaveQueue: (id) => connection.leaveQueue(id),
      acceptOffer: (id) => connection.acceptOffer(id),
    },
    voice: {
      getVoice: () => connection.getState().voice,
      subscribe: connection.subscribe,
      join: (state) => connection.joinVoice(state),
      leave: () => connection.leaveVoice(),
      setState: (state) => connection.setVoiceState(state),
    },
    moderation: {
      serverMute: (userId, muted) => connection.serverMute(userId, muted),
      kick: (userId) => connection.kickFromVoice(userId),
      cameraOff: (userId) => connection.cameraOff(userId),
    },
    chat: {
      listen: connection.listen,
      request: (type, payload) => connection.sendRequest(type, payload),
    },
    pointer: pointerSocket({
      listen: connection.listen,
      sendRequest: (type, payload) => connection.sendRequest(type, payload),
    }),
  };
}
