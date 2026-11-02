// SPDX-License-Identifier: AGPL-3.0-only
import type { Layer, PlayerSource, Rid, SourceState, StatsReportLike } from '../source.ts';

// Development only: a PlayerSource with no backend. A canvas draws a moving clock (captureStream)
// and WebAudio beeps once a second, so the player, its controls, stats for nerds, Automatic and
// the watchdog can be exercised in a browser. getStats() returns synthetic numbers shaped like an
// RTCStatsReport. Loaded with a dynamic import behind `import.meta.env.MODE !== 'production'`,
// so production builds never contain it.

export const FAKE_LAYERS: readonly Layer[] = [
  { rid: 'f', height: 1080, fps: 60 },
  { rid: 'h', height: 720, fps: 60 },
  { rid: 'q', height: 480, fps: 30 },
];

const BITRATE: Record<Rid, number> = { f: 8_000_000, h: 4_000_000, q: 1_200_000 };

export interface FakeConditions {
  /** Share of packets reported lost, 0–1. */
  loss: number;
  /** Stop drawing frames (the watchdog sees a stall; `retry()` clears it). */
  frozen: boolean;
  /** The next connect fails with this reason instead. */
  failWith: 'no_permission' | 'helper_outdated' | null;
}

export class FakeSource implements PlayerSource {
  state: SourceState = { kind: 'connecting' };
  layers: readonly Layer[] = FAKE_LAYERS;
  layer: Rid | null = null;
  readonly stream = new MediaStream();
  conditions: FakeConditions = { loss: 0, frozen: false, failWith: null };

  private readonly listeners = new Set<() => void>();
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D | null;
  private audio: AudioContext | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private frames = 0;
  private bytes = 0;
  private packets = 0;
  private lost = 0;
  private lossCarry = 0;
  private tick = 0;
  private lastTick = performance.now();
  private readonly startedAt = performance.now();

  constructor(
    private readonly label: string,
    options: { audio: boolean; connectMs?: number } = { audio: true },
  ) {
    this.context = this.canvas.getContext('2d');
    this.resize('f');
    const video = this.canvas.captureStream(60).getVideoTracks()[0];
    if (video) {
      // Same hint the helper uses for screen content.
      video.contentHint = 'motion';
      this.stream.addTrack(video);
    }
    if (options.audio) this.startAudio();
    this.connect(options.connectMs ?? 700);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setLayer(rid: Rid): void {
    if (rid === this.layer) return;
    this.resize(rid);
    this.emit();
  }

  retry(): void {
    this.conditions = { ...this.conditions, frozen: false };
    this.stopFrames();
    this.state = { kind: 'reconnecting', attempt: 1 };
    this.emit();
    this.connect(600);
  }

  /** Changes the simulated network or helper (the dev page's controls). */
  simulate(conditions: Partial<FakeConditions>): void {
    this.conditions = { ...this.conditions, ...conditions };
  }

  stop(): void {
    this.stopFrames();
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    for (const track of this.stream.getTracks()) track.stop();
    void this.audio?.close();
    this.audio = null;
  }

  getStats(): Promise<StatsReportLike> {
    const height = this.canvas.height;
    const width = this.canvas.width;
    const fps = this.layers.find((l) => l.rid === this.layer)?.fps ?? 60;
    const report = new Map<string, Record<string, unknown> & { type: string; id: string }>([
      [
        'IT01V',
        {
          id: 'IT01V',
          type: 'inbound-rtp',
          kind: 'video',
          codecId: 'CIT01_102',
          framesDecoded: this.frames,
          frameWidth: width,
          frameHeight: height,
          bytesReceived: this.bytes,
          packetsReceived: this.packets,
          packetsLost: this.lost,
          freezeCount: 0,
          totalDecodeTime: this.frames * (height > 900 ? 0.0021 : 0.0012),
          jitterBufferDelay: this.frames * 0.012,
          jitterBufferEmittedCount: this.frames,
          framesPerSecond: fps,
        },
      ],
      ['CIT01_102', { id: 'CIT01_102', type: 'codec', mimeType: 'video/H264', payloadType: 102 }],
      [
        'IT01A',
        {
          id: 'IT01A',
          type: 'inbound-rtp',
          kind: 'audio',
          bytesReceived: Math.round(((performance.now() - this.startedAt) / 1000) * 16_000),
        },
      ],
      ['CP1', { id: 'CP1', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.031 }],
    ]);
    return Promise.resolve(report);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private connect(delayMs: number): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      const failWith = this.conditions.failWith;
      if (failWith) {
        this.state = { kind: 'failed', reason: failWith };
        this.conditions = { ...this.conditions, failWith: null };
      } else {
        this.state = { kind: 'live' };
        this.layer ??= 'f';
        this.startFrames();
      }
      this.emit();
    }, delayMs);
  }

  private resize(rid: Rid): void {
    const height = this.layers.find((l) => l.rid === rid)?.height ?? 1080;
    this.canvas.height = height;
    this.canvas.width = Math.round((height * 16) / 9);
    this.layer = rid;
  }

  private startFrames(): void {
    this.stopFrames();
    this.lastTick = performance.now();
    this.frameTimer = setInterval(() => this.draw(), 1000 / 60);
  }

  private stopFrames(): void {
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    this.frameTimer = null;
  }

  private draw(): void {
    const now = performance.now();
    const seconds = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.conditions.frozen) return;
    const rid = this.layer ?? 'f';
    const fps = this.layers.find((l) => l.rid === rid)?.fps ?? 60;
    // The low layer runs at 30 fps: skip every other tick.
    this.tick += 1;
    if (fps < 60 && this.tick % 2 === 0) return;
    this.frames += 1;
    const bytes = (BITRATE[rid] / 8) * seconds;
    const packets = Math.max(1, Math.round(bytes / 1200));
    this.bytes += bytes;
    this.lossCarry += packets * this.conditions.loss;
    const lost = Math.min(packets, Math.floor(this.lossCarry));
    this.lossCarry -= lost;
    this.packets += packets - lost;
    this.lost += lost;

    const ctx = this.context;
    if (!ctx) return;
    const { width, height } = this.canvas;
    const t = (now - this.startedAt) / 1000;
    ctx.fillStyle = '#10130d';
    ctx.fillRect(0, 0, width, height);
    // A bar sweeping across, so motion (and stutter) is easy to see.
    ctx.fillStyle = '#5b7a3a';
    const bar = width / 12;
    ctx.fillRect((((t * width) / 4) % (width + bar)) - bar, 0, bar, height);
    ctx.fillStyle = '#f5f5ef';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(height / 7)}px Inter, system-ui, sans-serif`;
    const clock = new Date();
    const ms = String(clock.getMilliseconds()).padStart(3, '0');
    ctx.fillText(`${clock.toLocaleTimeString('en-GB')}.${ms}`, width / 2, height / 2);
    ctx.font = `500 ${Math.round(height / 22)}px Inter, system-ui, sans-serif`;
    ctx.fillText(
      `${this.label} · ${height}p${fps} · layer ${rid} · frame ${this.frames}`,
      width / 2,
      height / 2 + height / 7,
    );
  }

  private startAudio(): void {
    try {
      const audio = new AudioContext();
      const destination = audio.createMediaStreamDestination();
      const gain = audio.createGain();
      gain.gain.value = 0;
      const tone = audio.createOscillator();
      tone.frequency.value = 660;
      tone.connect(gain).connect(destination);
      tone.start();
      // A 120 ms beep at the top of every second.
      const schedule = () => {
        if (this.audio !== audio) return;
        const start = Math.ceil(audio.currentTime);
        gain.gain.setValueAtTime(0.2, start);
        gain.gain.setValueAtTime(0, start + 0.12);
        setTimeout(schedule, 1000);
      };
      this.audio = audio;
      schedule();
      const track = destination.stream.getAudioTracks()[0];
      if (track) this.stream.addTrack(track);
      // Suspended until the page gets a gesture (autoplay policy); the player's unmute is one.
      const resume = () => void audio.resume();
      document.addEventListener('pointerdown', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    } catch {
      // No WebAudio: a stream without audio, which the player shows as such.
    }
  }
}
