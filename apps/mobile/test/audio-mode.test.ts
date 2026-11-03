// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AudioModeController,
  DUCK_GAIN,
  focusGain,
  type FocusState,
  type NativeAudio,
} from '../src/audio/mode.ts';

// The audio mode: which native calls watching and voice make, and what audio focus does to the gain.

function fake() {
  const calls: string[] = [];
  let emit: (state: FocusState) => void = () => undefined;
  const native: NativeAudio = {
    setMode: (mode) => void calls.push(`setMode ${mode}`),
    release: () => void calls.push('release'),
    onFocusChange: (listener) => {
      calls.push('listen');
      emit = listener;
      return () => void calls.push('unlisten');
    },
  };
  return { calls, native, focus: (state: FocusState) => emit(state) };
}

describe('AudioModeController', () => {
  it('sets the mode once and ignores the same mode again', () => {
    const { calls, native } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('media');
    audio.setAudioMode('media');
    expect(calls).toEqual(['listen', 'setMode media']);
    expect(audio.mode).toBe('media');
  });

  it('switches to communication for voice and back to media', () => {
    const { calls, native } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('media');
    audio.setAudioMode('communication');
    audio.setAudioMode('media');
    expect(calls.filter((c) => c.startsWith('setMode'))).toEqual([
      'setMode media',
      'setMode communication',
      'setMode media',
    ]);
    expect(calls.filter((c) => c === 'listen')).toHaveLength(1);
  });

  it('release gives everything back and stops listening', () => {
    const { calls, native } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('media');
    audio.releaseAudio();
    audio.releaseAudio();
    expect(calls).toEqual(['listen', 'setMode media', 'unlisten', 'release']);
    expect(audio.mode).toBeNull();
  });

  it('tracks audio focus and tells subscribers', () => {
    const { native, focus } = fake();
    const audio = new AudioModeController(native);
    let changes = 0;
    audio.subscribe(() => (changes += 1));
    audio.setAudioMode('media');
    focus('loss_transient');
    focus('loss_transient');
    expect(audio.getFocus()).toBe('loss_transient');
    focus('gain');
    expect(audio.getFocus()).toBe('gain');
    expect(changes).toBe(2);
  });

  it('asks for focus again only after it was lost', () => {
    const { calls, native, focus } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('media');
    audio.refocus();
    expect(calls.filter((c) => c.startsWith('setMode'))).toHaveLength(1);
    focus('loss');
    audio.refocus();
    expect(calls.filter((c) => c.startsWith('setMode'))).toHaveLength(2);
  });

  it('works without a native side (iOS, Expo Go)', () => {
    const audio = new AudioModeController(null);
    audio.setAudioMode('media');
    audio.releaseAudio();
    expect(audio.mode).toBeNull();
  });

  it('maps focus to a gain: a call mutes, a notification ducks', () => {
    expect(focusGain('gain')).toBe(1);
    expect(focusGain('duck')).toBe(DUCK_GAIN);
    expect(focusGain('loss_transient')).toBe(0);
    expect(focusGain('loss')).toBe(0);
  });
});

describe('voice owns the mode', () => {
  it('goes to communication and back to media when a stream was playing', () => {
    const { calls, native } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('media');
    audio.enterVoice();
    audio.setAudioMode('media');
    audio.releaseAudio();
    audio.setAudioMode('media');
    expect(audio.mode).toBe('communication');
    audio.leaveVoice();
    expect(audio.mode).toBe('media');
    expect(calls.filter((c) => c.startsWith('setMode'))).toEqual([
      'setMode media',
      'setMode communication',
      'setMode media',
    ]);
  });

  it('releases after voice when nothing was watched, or the player closed meanwhile', () => {
    const { calls, native } = fake();
    const audio = new AudioModeController(native);
    audio.enterVoice();
    audio.leaveVoice();
    expect(audio.mode).toBeNull();
    audio.setAudioMode('media');
    audio.enterVoice();
    audio.releaseMedia();
    audio.leaveVoice();
    expect(audio.mode).toBeNull();
    expect(calls.filter((c) => c === 'release')).toHaveLength(2);
  });

  it('releaseMedia only releases media', () => {
    const { native } = fake();
    const audio = new AudioModeController(native);
    audio.setAudioMode('communication');
    audio.releaseMedia();
    expect(audio.mode).toBe('communication');
    audio.setAudioMode('media');
    audio.releaseMedia();
    expect(audio.mode).toBeNull();
  });
});
