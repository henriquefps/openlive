// SPDX-License-Identifier: AGPL-3.0-only
// The notice sounds: a few sine notes with a soft attack
// and decay, made here with WebAudio, so there are no files to ship and they sound the same
// everywhere. start, stop, alert and viewer are the helper's set note for note
// (helper/internal/notify/sound.go, checked by test/notice-sounds.test.ts); the web adds voice
// join and leave, the queue's slot and the chat mention.

export type Sound = 'start' | 'stop' | 'alert' | 'viewer' | 'join' | 'leave' | 'slot' | 'mention';

/** A note: its pitch (0 is a rest) and length. */
export interface Note {
  hz: number;
  ms: number;
}

export const NOTES: Record<Sound, readonly Note[]> = {
  // Short and soft: a stream started.
  start: [
    { hz: 660, ms: 90 },
    { hz: 880, ms: 160 },
  ],
  // The start's answer, falling.
  stop: [
    { hz: 880, ms: 90 },
    { hz: 660, ms: 160 },
  ],
  // The stream dropped or the network is unstable.
  alert: [
    { hz: 988, ms: 110 },
    { hz: 0, ms: 50 },
    { hz: 988, ms: 110 },
    { hz: 0, ms: 50 },
    { hz: 740, ms: 200 },
  ],
  // Discreet: someone started watching.
  viewer: [{ hz: 1175, ms: 70 }],
  // Lower and quicker than start, so voice is not mistaken for a stream.
  join: [
    { hz: 523, ms: 70 },
    { hz: 784, ms: 120 },
  ],
  leave: [
    { hz: 784, ms: 70 },
    { hz: 523, ms: 120 },
  ],
  // Prominent: a slot opened and there are 30 s to take it.
  slot: [
    { hz: 784, ms: 100 },
    { hz: 988, ms: 100 },
    { hz: 1175, ms: 100 },
    { hz: 0, ms: 60 },
    { hz: 1175, ms: 220 },
  ],
  mention: [
    { hz: 1047, ms: 60 },
    { hz: 0, ms: 40 },
    { hz: 1319, ms: 90 },
  ],
};

/** The helper's amplitude (0.25 of full scale), times the user's volume. */
export const PEAK = 0.25;
export const ATTACK_S = 0.005;
export const RELEASE_S = 0.04;

/** Plays one sound (the browser's WebAudio, the app's speaker; a fake in tests). */
export interface SoundOutput {
  play(sound: Sound, volume: number): void;
}
