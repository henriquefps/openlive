// SPDX-License-Identifier: AGPL-3.0-only
import { ATTACK_S, NOTES, PEAK, RELEASE_S, type Sound } from '@openlive/client';

// The notice sounds (the web's sine notes, @openlive/client notices/sounds.ts) rendered to 16-bit
// mono PCM, the same attack and release as the web's WebAudio player, so a cue sounds the same on
// the phone. The native side plays the samples (modules/openlive-audio, `playCue`).

export const CUE_SAMPLE_RATE = 22_050;

export interface Cue {
  /** 16-bit little-endian mono PCM, base64. */
  base64: string;
  sampleRate: number;
  /** How long it plays. */
  ms: number;
}

/** The samples of a sound at `volume` (0–1 times the helper's peak of 0.25). */
export function renderCue(sound: Sound, volume: number, sampleRate = CUE_SAMPLE_RATE): Int16Array {
  const peak = PEAK * Math.min(1, Math.max(0, volume));
  const notes = NOTES[sound];
  const total = notes.reduce((sum, n) => sum + Math.round((n.ms / 1000) * sampleRate), 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const note of notes) {
    const length = Math.round((note.ms / 1000) * sampleRate);
    if (note.hz > 0) {
      const seconds = note.ms / 1000;
      for (let i = 0; i < length; i += 1) {
        const t = i / sampleRate;
        // Linear attack, a plateau, a linear release to zero at the note's end.
        const gain =
          t < ATTACK_S
            ? t / ATTACK_S
            : t > seconds - RELEASE_S
              ? Math.max(0, (seconds - t) / RELEASE_S)
              : 1;
        out[at + i] = Math.round(Math.sin(2 * Math.PI * note.hz * t) * gain * peak * 32767);
      }
    }
    at += length;
  }
  return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (no atob/btoa: the bytes are binary). */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[c & 63] : '=';
  }
  return out;
}

/** The sound as base64 PCM; the volume is rounded to 5 % steps so the cache stays small. */
export function cueOf(sound: Sound, volume: number): Cue {
  const step = Math.round(Math.min(1, Math.max(0, volume)) * 20) / 20;
  const samples = renderCue(sound, step);
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return {
    base64: toBase64(bytes),
    sampleRate: CUE_SAMPLE_RATE,
    ms: Math.round((samples.length / CUE_SAMPLE_RATE) * 1000),
  };
}
