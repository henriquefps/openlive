// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the voice on a phone that are about the phone, not the call: what the app does when
// it goes to the background, and when the network changes. Pure, so they are tested without a
// device.

export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export interface BackgroundInput {
  appState: AppStateName;
  /** Joining or joined voice here or in any room. */
  inVoice: boolean;
  /** The room socket is waiting to reconnect. */
  reconnecting: boolean;
  /** A stream is being watched (its viewer slot is the player's). */
  watching: boolean;
}

export interface BackgroundActions {
  /** The watch slot is given back (the player does it: a stream nobody sees costs the room). */
  releaseWatch: boolean;
  /** Close the voice, the room socket or the SFU sessions: never while in voice. */
  releaseVoice: boolean;
  /** Back in front with a socket that gave up waiting: try now. */
  reconnectNow: boolean;
  /**
   * The camera goes off: Android takes the camera from an app that is not in front (the
   * foreground service is a microphone one), so it is closed cleanly instead of dying as
   * "device lost". It is not turned on again by itself.
   */
  stopCamera: boolean;
}

/**
 * What going to the background or coming back does. The voice keeps its room socket, its SFU
 * sessions and the foreground service with the screen locked or another app in front; only the
 * watch slot is released, as before voice existed (player/useWatch.ts).
 */
export function backgroundRules(input: BackgroundInput): BackgroundActions {
  const active = input.appState === 'active';
  return {
    releaseWatch: !active && input.watching,
    releaseVoice: false,
    reconnectNow: active && input.reconnecting,
    stopCamera: !active,
  };
}

export interface NetworkInfo {
  isConnected: boolean;
  /** 'wifi', 'cellular', ... (expo-network's NetworkStateType). */
  type: string;
}

/**
 * Wi-Fi to cellular (or the network coming back): the room socket and the SFU connection on the
 * old network are dead or about to be, so the reconnect is tried at once instead of after the
 * backoff, without leaving voice (the SFU session replaces itself and voice publishes again).
 */
export function reconnectOnNetwork(
  previous: NetworkInfo | null,
  next: NetworkInfo,
  inVoice: boolean,
): boolean {
  if (!next.isConnected) return false;
  if (previous === null) return false;
  if (!previous.isConnected) return true;
  return inVoice && previous.type !== next.type;
}

/** Hold-to-talk: the button's press and release (a cancelled touch is a release). */
export type PttEvent = 'down' | 'up' | 'cancel';
export const pttPressed = (event: PttEvent): boolean => event === 'down';
