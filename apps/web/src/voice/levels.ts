// SPDX-License-Identifier: AGPL-3.0-only
import { type LevelReader, rms, SampledLevelMonitor } from '@openlive/client';

// Who is speaking (@openlive/client, voice/levels.ts has the gate and the sampling), measured here
// from each voice's audio: an AnalyserNode per track, read ten
// times a second. Nothing is sent anywhere.

export {
  rms,
  SAMPLE_INTERVAL_MS,
  SPEAKING_HOLD_MS,
  SPEAKING_LEVEL,
  SpeakingGate,
} from '@openlive/client';

export class LevelMonitor extends SampledLevelMonitor<MediaStreamTrack> {
  private context: AudioContext | null = null;

  constructor(
    onChange: (id: string, speaking: boolean) => void,
    now: () => number = () => performance.now(),
  ) {
    super({ onChange, now, open: (track) => this.openReader(track) });
  }

  override dispose(): void {
    super.dispose();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private openReader(track: MediaStreamTrack): LevelReader | null {
    const context = this.audioContext();
    if (!context) return null;
    void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    // Analysis only: not connected to the speakers.
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      read: () => {
        analyser.getFloatTimeDomainData(buffer);
        return rms(buffer);
      },
      close: () => source.disconnect(),
    };
  }

  private audioContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === 'undefined') return null;
    this.context = new AudioContext();
    return this.context;
  }
}
