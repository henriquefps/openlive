// SPDX-License-Identifier: AGPL-3.0-only
// The notice sounds: the notes are in @openlive/client
// (notices/sounds.ts), shared with the mobile app; this is the browser's WebAudio player.
import { ATTACK_S, NOTES, PEAK, RELEASE_S, type Sound, type SoundOutput } from '@openlive/client';

export { ATTACK_S, NOTES, PEAK, RELEASE_S };
export type { Note, Sound, SoundOutput } from '@openlive/client';

/**
 * WebAudio sounds. The context is made on the page's first interaction (`unlock`), when the
 * autoplay rules let it run; it keeps running with the tab in the background.
 */
export class WebAudioSounds implements SoundOutput {
  private context: (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null = null;
  private sinkId = '';

  unlock(): void {
    if (typeof AudioContext === 'undefined') return;
    if (!this.context) {
      this.context = new AudioContext();
      if (this.sinkId) void this.context.setSinkId?.(this.sinkId).catch(() => undefined);
    }
    void this.context.resume().catch(() => undefined);
  }

  /**
   * The output the sounds play on: the voice sink while voice plays into it, so a shared browser
   * window's audio does not carry them to the stream; '' is the default. Where
   * AudioContext has no setSinkId (Firefox, Safari) they stay on the default.
   */
  setSink(deviceId: string): void {
    if (deviceId === this.sinkId) return;
    this.sinkId = deviceId;
    void this.context?.setSinkId?.(deviceId).catch(() => undefined);
  }

  play(sound: Sound, volume: number): void {
    const context = this.context;
    if (!context || volume <= 0) return;
    let at = context.currentTime + 0.01;
    const peak = PEAK * Math.min(1, volume);
    for (const note of NOTES[sound]) {
      const length = note.ms / 1000;
      if (note.hz > 0) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.frequency.value = note.hz;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(peak, at + ATTACK_S);
        gain.gain.setValueAtTime(peak, at + Math.max(ATTACK_S, length - RELEASE_S));
        gain.gain.linearRampToValueAtTime(0, at + length);
        osc.connect(gain).connect(context.destination);
        osc.start(at);
        osc.stop(at + length + 0.01);
        osc.onended = () => gain.disconnect();
      }
      at += length;
    }
  }

  dispose(): void {
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
