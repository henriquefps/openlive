// SPDX-License-Identifier: AGPL-3.0-only

// The app's audio mode. Watching a stream plays as media (the media volume on the volume keys,
// Bluetooth A2DP, audio focus as a movie player); voice (A3) switches to communication (call
// volume, echo cancellation) and back. The Android side is modules/openlive-audio; this file is the
// state and the rules, with the native side injected so they are tested without a phone.

export type AudioMode = 'media' | 'communication';

/** What the system says about our audio focus. */
export type FocusState = 'gain' | 'duck' | 'loss_transient' | 'loss';

export interface NativeAudio {
  setMode(mode: AudioMode): void;
  release(): void;
  onFocusChange(listener: (state: FocusState) => void): () => void;
}

/** The gain of the stream while another sound ducks it. */
export const DUCK_GAIN = 0.3;

/** The gain factor (0–1) the stream's audio gets in a focus state: a call or other music mutes it. */
export const focusGain = (state: FocusState): number =>
  state === 'gain' ? 1 : state === 'duck' ? DUCK_GAIN : 0;

export class AudioModeController {
  private current: AudioMode | null = null;
  // A voice session (enterVoice) owns the mode: the player's media / release requests during it
  // only decide what the mode goes back to when voice ends.
  private voice = false;
  private after: AudioMode | null = null;
  private focus: FocusState = 'gain';
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;

  constructor(private readonly native: NativeAudio | null) {}

  /** The mode set, or null while the app holds no audio. */
  get mode(): AudioMode | null {
    return this.current;
  }

  getFocus = (): FocusState => this.focus;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Switches the mode (a no-op when it is already set); takes audio focus for it. */
  setAudioMode(mode: AudioMode): void {
    if (this.voice) {
      if (mode === 'media') this.after = 'media';
      return;
    }
    this.apply(mode);
  }

  /** Voice starts: communication mode, whatever was playing as media is remembered. */
  enterVoice(): void {
    if (this.voice) return;
    this.voice = true;
    this.after = this.current === 'media' ? 'media' : null;
    this.apply('communication');
  }

  /** Voice ends: back to media when a stream is still watched, otherwise everything is released. */
  leaveVoice(): void {
    if (!this.voice) return;
    this.voice = false;
    const back = this.after;
    this.after = null;
    if (back) this.apply(back);
    else this.releaseAudio();
  }

  /** The stream player closes: media is released, unless voice is on (it keeps the audio). */
  releaseMedia(): void {
    if (this.voice) this.after = null;
    else if (this.current === 'media') this.releaseAudio();
  }

  private apply(mode: AudioMode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.listen();
    this.native?.setMode(mode);
  }

  /** Asks for audio focus again (the app came back after another sound took it for good). */
  refocus(): void {
    if (this.current && this.focus !== 'gain') this.native?.setMode(this.current);
  }

  /** Nothing is playing or talking: gives focus and the volume keys back to the system. */
  releaseAudio(): void {
    if (this.voice) {
      this.after = null;
      return;
    }
    if (!this.current) return;
    this.current = null;
    this.off?.();
    this.off = null;
    this.native?.release();
    this.setFocus('gain');
  }

  private listen(): void {
    if (this.off || !this.native) return;
    this.off = this.native.onFocusChange((state) => this.setFocus(state));
  }

  private setFocus(state: FocusState): void {
    if (state === this.focus) return;
    this.focus = state;
    for (const listener of [...this.listeners]) listener();
  }
}
