// SPDX-License-Identifier: AGPL-3.0-only
import type { Sound, SoundOutput } from '@openlive/client';
import { type Cue, cueOf } from './wav.ts';

/**
 * The notice sounds on the phone's speaker. The native side picks the route: the call's while the
 * app is in voice (communication mode, the call volume), the notification-sound route otherwise
 * (media volume, no audio focus taken, so a stream being watched keeps playing under the cue).
 */
export class PhoneSounds implements SoundOutput {
  private readonly cache = new Map<string, Cue>();

  constructor(private readonly play_: (cue: Cue) => void) {}

  play(sound: Sound, volume: number): void {
    if (volume <= 0) return;
    const key = `${sound}/${Math.round(Math.min(1, volume) * 20)}`;
    let cue = this.cache.get(key);
    if (!cue) {
      cue = cueOf(sound, volume);
      this.cache.set(key, cue);
    }
    try {
      this.play_(cue);
    } catch {
      // A cue that cannot play is not worth an error.
    }
  }
}
