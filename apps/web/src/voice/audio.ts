// SPDX-License-Identifier: AGPL-3.0-only
import type { VoiceOutput } from './client.ts';

// Plays the others' voices. Each person gets an <audio> element: the browser's echo cancellation
// covers what media elements play, and setSinkId picks the speakers. Above 100 % (up to 200 %)
// the element is muted and the voice goes through a WebAudio gain instead, on an AudioContext
// that follows the same speakers where it can (AudioContext.setSinkId). Chrome only feeds a
// remote WebRTC track into WebAudio while an element plays it, so the muted element stays.

type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

interface Voice {
  element: SinkElement;
  stream: MediaStream;
  volume: number;
  /** The boost path, only while above 100 %. */
  boost: { source: MediaStreamAudioSourceNode; gain: GainNode } | null;
}

export const canPickSink = (): boolean =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export class AudioPlayback implements VoiceOutput {
  readonly canPickSink = canPickSink();
  private readonly voices = new Map<string, Voice>();
  private deafened = false;
  private sinkId = '';
  private context: SinkContext | null = null;

  constructor(private readonly root: HTMLElement = document.body) {}

  attach(userId: string, track: MediaStreamTrack, volume: number): void {
    this.detach(userId);
    const stream = new MediaStream([track]);
    const element = document.createElement('audio') as SinkElement;
    element.autoplay = true;
    element.dataset['voice'] = userId;
    element.srcObject = stream;
    element.hidden = true;
    this.root.append(element);
    if (this.sinkId && element.setSinkId)
      void element.setSinkId(this.sinkId).catch(() => undefined);
    const voice: Voice = { element, stream, volume, boost: null };
    this.voices.set(userId, voice);
    this.apply(voice);
    void element.play().catch(() => undefined);
  }

  detach(userId: string): void {
    const voice = this.voices.get(userId);
    if (!voice) return;
    this.voices.delete(userId);
    this.unboost(voice);
    voice.element.pause();
    voice.element.srcObject = null;
    voice.element.remove();
  }

  setVolume(userId: string, volume: number): void {
    const voice = this.voices.get(userId);
    if (!voice) return;
    voice.volume = volume;
    this.apply(voice);
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const voice of this.voices.values()) this.apply(voice);
  }

  async setSink(deviceId: string): Promise<boolean> {
    this.sinkId = deviceId;
    if (!this.canPickSink) return false;
    const elements = [...this.voices.values()].map((v) => v.element);
    await Promise.all(elements.map((e) => e.setSinkId?.(deviceId).catch(() => undefined)));
    await this.context?.setSinkId?.(deviceId).catch(() => undefined);
    return true;
  }

  resume(): void {
    void this.context?.resume().catch(() => undefined);
  }

  dispose(): void {
    for (const userId of [...this.voices.keys()]) this.detach(userId);
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private apply(voice: Voice): void {
    const { element } = voice;
    if (voice.volume <= 1) {
      this.unboost(voice);
      element.volume = voice.volume;
      element.muted = this.deafened;
      return;
    }
    element.muted = true;
    const boost = voice.boost ?? this.boost(voice);
    if (boost) boost.gain.gain.value = this.deafened ? 0 : voice.volume;
    else {
      // No WebAudio: as loud as the element goes.
      element.muted = this.deafened;
      element.volume = 1;
    }
  }

  private boost(voice: Voice): Voice['boost'] {
    const context = this.audioContext();
    if (!context) return null;
    const source = context.createMediaStreamSource(voice.stream);
    const gain = context.createGain();
    source.connect(gain).connect(context.destination);
    voice.boost = { source, gain };
    return voice.boost;
  }

  private unboost(voice: Voice): void {
    if (!voice.boost) return;
    voice.boost.source.disconnect();
    voice.boost.gain.disconnect();
    voice.boost = null;
  }

  private audioContext(): SinkContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === 'undefined') return null;
    this.context = new AudioContext() as SinkContext;
    if (this.sinkId) void this.context.setSinkId?.(this.sinkId).catch(() => undefined);
    return this.context;
  }
}
