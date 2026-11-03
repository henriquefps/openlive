// SPDX-License-Identifier: AGPL-3.0-only
import type { MediaTrackLike, VoiceOutput } from '@openlive/client';

// Plays the others' voices on the phone. react-native-webrtc plays a received audio track by
// itself, through the audio device the voice session picked (voice-native: communication mode,
// echo cancellation, speaker / earpiece / headset); what is left here is each person's volume and
// deafen. Tracks are the platform's MediaStreamTrack; the volume setter is injected so the rules
// are tested without a phone.

/** A remote audio track as the output needs it. */
export interface PlayableTrack {
  /** react-native-webrtc's `_setVolume` (0 silent, 1 the sent level, up to 10). */
  setVolume(volume: number): void;
}

export class PhoneVoiceOutput<T extends MediaTrackLike> implements VoiceOutput<T> {
  private readonly tracks = new Map<string, { track: T; volume: number }>();
  private deafened = false;
  readonly canPickSink = false;

  constructor(private readonly playable: (track: T) => PlayableTrack) {}

  attach(userId: string, track: T, volume: number): void {
    this.tracks.set(userId, { track, volume });
    this.apply(userId);
  }

  detach(userId: string): void {
    this.tracks.delete(userId);
  }

  setVolume(userId: string, volume: number): void {
    const entry = this.tracks.get(userId);
    if (!entry) return;
    entry.volume = volume;
    this.apply(userId);
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const userId of this.tracks.keys()) this.apply(userId);
  }

  /** The route (speaker, earpiece, headset) is the phone's, not the app's output list. */
  setSink(): Promise<boolean> {
    return Promise.resolve(false);
  }

  resume(): void {
    // No autoplay rules on a phone.
  }

  dispose(): void {
    this.tracks.clear();
  }

  private apply(userId: string): void {
    const entry = this.tracks.get(userId);
    if (!entry) return;
    this.playable(entry.track).setVolume(this.deafened ? 0 : entry.volume);
  }
}
