// SPDX-License-Identifier: AGPL-3.0-only
import type { SpeakingMonitor } from './client.ts';

// Who is speaking, measured here from each voice's audio: an
// AnalyserNode per track, read ten times a second. Speaking starts above a level and ends after
// a short hold below it, so the ring does not flicker between words. Nothing is sent anywhere.

/** RMS of the samples above which a voice counts as speaking (about -40 dBFS). */
export const SPEAKING_LEVEL = 0.01;
/** Below the level this long before speaking ends. */
export const SPEAKING_HOLD_MS = 400;
export const SAMPLE_INTERVAL_MS = 100;

/** The RMS of a block of samples (-1 to 1). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Turns a level reading into speaking or not, with the hold. */
export class SpeakingGate {
  speaking = false;
  private lastLoud = -Infinity;

  update(level: number, now: number): boolean {
    if (level >= SPEAKING_LEVEL) {
      this.lastLoud = now;
      this.speaking = true;
    } else if (this.speaking && now - this.lastLoud >= SPEAKING_HOLD_MS) {
      this.speaking = false;
    }
    return this.speaking;
  }
}

interface Meter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  gate: SpeakingGate;
}

export class LevelMonitor implements SpeakingMonitor {
  private context: AudioContext | null = null;
  private readonly meters = new Map<string, Meter>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (id: string, speaking: boolean) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  add(id: string, track: MediaStreamTrack): void {
    this.remove(id);
    const context = this.audioContext();
    if (!context) return;
    void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    // Analysis only: not connected to the speakers.
    source.connect(analyser);
    this.meters.set(id, {
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      gate: new SpeakingGate(),
    });
    this.timer ??= setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  remove(id: string): void {
    const meter = this.meters.get(id);
    if (!meter) return;
    this.meters.delete(id);
    meter.source.disconnect();
    if (meter.gate.speaking) this.onChange(id, false);
    if (this.meters.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    for (const id of [...this.meters.keys()]) this.remove(id);
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private sample(): void {
    const now = this.now();
    for (const [id, meter] of this.meters) {
      meter.analyser.getFloatTimeDomainData(meter.buffer);
      const was = meter.gate.speaking;
      if (meter.gate.update(rms(meter.buffer), now) !== was) this.onChange(id, !was);
    }
  }

  private audioContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === 'undefined') return null;
    this.context = new AudioContext();
    return this.context;
  }
}
