// SPDX-License-Identifier: AGPL-3.0-only
import { NOTES, type Sound } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { PhoneSounds } from '../src/notices/sounds.ts';
import { CUE_SAMPLE_RATE, cueOf, renderCue, toBase64 } from '../src/notices/wav.ts';

const SOUNDS = Object.keys(NOTES) as Sound[];

describe('renderCue', () => {
  it('lasts as long as the web sound and is silent at both ends and on rests', () => {
    for (const sound of SOUNDS) {
      const samples = renderCue(sound, 1);
      const ms = NOTES[sound].reduce((sum, n) => sum + n.ms, 0);
      expect(Math.abs(samples.length - (ms / 1000) * CUE_SAMPLE_RATE)).toBeLessThan(
        NOTES[sound].length,
      );
      expect(samples[0]).toBe(0);
      expect(Math.abs(samples.at(-1) ?? 0)).toBeLessThan(200);
    }
    // 'alert' has rests: 110 ms note, 50 ms rest.
    const alert = renderCue('alert', 1);
    const rest = Math.round(0.135 * CUE_SAMPLE_RATE);
    expect(alert[rest]).toBe(0);
  });

  it('peaks at the helper level (0.25) times the volume, and 0 volume is silence', () => {
    const peak = (v: number) => Math.max(...Array.from(renderCue('start', v), Math.abs));
    expect(peak(1)).toBeGreaterThan(0.24 * 32767);
    expect(peak(1)).toBeLessThanOrEqual(Math.ceil(0.25 * 32767));
    expect(peak(0.5)).toBeLessThan(peak(1) * 0.55);
    expect(peak(0)).toBe(0);
  });
});

describe('base64', () => {
  it('encodes like the standard alphabet, with padding', () => {
    const enc = (s: string) => toBase64(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });

  it('a cue is 16-bit PCM: twice the samples in bytes', () => {
    const cue = cueOf('join', 0.7);
    expect(Buffer.from(cue.base64, 'base64').length).toBe(renderCue('join', 0.7).length * 2);
    expect(cue.ms).toBe(190);
  });
});

describe('PhoneSounds', () => {
  it('plays a rendered cue once per call, caches by volume step and skips silence', () => {
    const played: string[] = [];
    const sounds = new PhoneSounds((cue) => played.push(cue.base64));
    sounds.play('mention', 0.7);
    sounds.play('mention', 0.7);
    sounds.play('mention', 0);
    expect(played).toHaveLength(2);
    expect(played[0]).toBe(played[1]);
  });

  it('survives a player that throws', () => {
    const sounds = new PhoneSounds(() => {
      throw new Error('no audio');
    });
    expect(() => sounds.play('start', 1)).not.toThrow();
  });
});
