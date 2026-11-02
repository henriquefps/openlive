// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import type { Publication } from '../src/rtc/session.ts';
import {
  type DevicesLike,
  type SignalVoice,
  VoiceClient,
  type VoiceMedia,
  type VoiceOutput,
  type VoiceSignal,
} from '../src/voice/client.ts';
import type { VoiceParticipant, VoiceTrack } from '../src/voice/contract.ts';
import { DEFAULT_PREFS, type VoicePrefs } from '../src/voice/prefs.ts';

// Fakes for the voice client: the room socket's voice part, the SFU session, the media devices,
// the speakers and the level meter. jsdom has no getUserMedia, WebRTC or WebAudio.

export class FakeMicTrack extends EventTarget {
  readonly kind = 'audio';
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  constructor(readonly id: string) {
    super();
  }
  stop() {
    this.readyState = 'ended';
  }
  /** The device went away: the browser ends the track. */
  unplug() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export const asTrack = (t: FakeMicTrack) => t as unknown as MediaStreamTrack;

export class FakeSignal implements VoiceSignal {
  voice: SignalVoice = {
    self: 'out',
    selfId: 'u_me',
    canSpeak: true,
    participants: [],
    tracks: [],
    cameras: [],
    canUseCamera: true,
    cameraStopped: null,
    error: null,
    left: null,
  };
  readonly sent: { type: string; payload?: unknown }[] = [];
  private readonly listeners = new Set<() => void>();

  getVoice = () => this.voice;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  join(state: { muted: boolean; deafened: boolean }) {
    this.sent.push({ type: 'voice.join', payload: state });
    this.update({ self: 'joining', error: null, left: null });
  }
  leave() {
    this.sent.push({ type: 'voice.leave' });
    this.update({ self: 'out', tracks: [], left: 'left' });
  }
  setState(state: { muted: boolean; deafened: boolean }) {
    this.sent.push({ type: 'voice.state', payload: state });
  }
  // --- test side ---
  update(patch: Partial<SignalVoice>) {
    this.voice = { ...this.voice, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** The room let this connection in, with these others already there. */
  admit(others: VoiceParticipant[] = []) {
    this.update({ self: 'in', participants: [participant('u_me'), ...others] });
  }
  states() {
    return this.sent.filter((m) => m.type === 'voice.state').map((m) => m.payload);
  }
}

export const participant = (
  userId: string,
  patch: Partial<VoiceParticipant> = {},
): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  serverMuted: false,
  joinedAt: 0,
  ...patch,
});

export const audioTrack = (userId: string): VoiceTrack => ({ userId, trackId: `tr_${userId}` });

export function fakeMedia() {
  const resetListeners = new Set<() => void>();
  const publications: (Publication & { replaced: (MediaStreamTrack | null)[] })[] = [];
  const media = {
    publish: vi.fn<VoiceMedia['publish']>(() => {
      const replaced: (MediaStreamTrack | null)[] = [];
      const publication = {
        sessionId: 's1',
        mid: String(publications.length),
        replaced,
        replaceTrack: (track: MediaStreamTrack | null) => {
          replaced.push(track);
          return Promise.resolve();
        },
        setActiveLayers: () => Promise.resolve(),
      };
      publications.push(publication);
      return Promise.resolve(publication);
    }),
    unpublish: vi.fn<VoiceMedia['unpublish']>(() => Promise.resolve()),
    pull: vi.fn<VoiceMedia['pull']>((tracks) =>
      Promise.resolve(
        new Map(tracks.map((t) => [t.trackId, asTrack(new FakeMicTrack(`remote-${t.userId}`))])),
      ),
    ),
    unpull: vi.fn<VoiceMedia['unpull']>(() => Promise.resolve()),
    onReset: (listener: () => void) => {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
  } satisfies VoiceMedia;
  return {
    media,
    publications,
    reset: () => {
      for (const listener of resetListeners) listener();
    },
  };
}

export function fakeDevices() {
  const mics: FakeMicTrack[] = [];
  const listeners = new Set<() => void>();
  let failure: string | null = null;
  const devices = {
    getUserMedia: vi.fn<DevicesLike['getUserMedia']>(() => {
      if (failure !== null) return Promise.reject(new DOMException('no', failure));
      const track = new FakeMicTrack(`mic-${mics.length + 1}`);
      mics.push(track);
      return Promise.resolve({
        getAudioTracks: () => [asTrack(track)],
        getTracks: () => [asTrack(track)],
      } as unknown as MediaStream);
    }),
    enumerateDevices: vi.fn<DevicesLike['enumerateDevices']>(() =>
      Promise.resolve([
        { deviceId: 'default', kind: 'audioinput', label: 'Default', groupId: '' },
        { deviceId: 'mic-a', kind: 'audioinput', label: 'Headset', groupId: '' },
        { deviceId: 'mic-b', kind: 'audioinput', label: '', groupId: '' },
        { deviceId: 'spk-a', kind: 'audiooutput', label: 'Speakers', groupId: '' },
      ] as unknown as MediaDeviceInfo[]),
    ),
    addEventListener: (_type: 'devicechange', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'devicechange', listener: () => void) =>
      listeners.delete(listener),
  } satisfies DevicesLike;
  return {
    devices,
    mics,
    /** getUserMedia rejects with this DOMException name from now on; null to stop. */
    fail: (name: string | null) => {
      failure = name;
    },
    change: () => {
      for (const listener of listeners) listener();
    },
  };
}

export function fakeOutput() {
  const playing = new Map<string, { track: MediaStreamTrack; volume: number }>();
  const output = {
    canPickSink: true,
    deafened: false,
    sink: '',
    attach: vi.fn((userId: string, track: MediaStreamTrack, volume: number) => {
      playing.set(userId, { track, volume });
    }),
    detach: vi.fn((userId: string) => {
      playing.delete(userId);
    }),
    setVolume: vi.fn((userId: string, volume: number) => {
      const voice = playing.get(userId);
      if (voice) voice.volume = volume;
    }),
    setDeafened(deafened: boolean) {
      this.deafened = deafened;
    },
    setSink(deviceId: string) {
      this.sink = deviceId;
      return Promise.resolve(true);
    },
    resume: vi.fn(),
    dispose: vi.fn(),
  } satisfies VoiceOutput & Record<string, unknown>;
  return { output, playing };
}

export function setupVoice(
  options: { prefs?: Partial<VoicePrefs>; keys?: EventTarget; noDevices?: boolean } = {},
) {
  const signal = new FakeSignal();
  const media = fakeMedia();
  const devices = fakeDevices();
  const { output, playing } = fakeOutput();
  let speak: (id: string, speaking: boolean) => void = () => undefined;
  const monitored = new Set<string>();
  const saved: VoicePrefs[] = [];
  const volumes = new Map<string, number>();
  const client = new VoiceClient({
    signal,
    media: media.media,
    devices: options.noDevices ? null : devices.devices,
    output,
    createMonitor: (onChange) => {
      speak = onChange;
      return {
        add: (id) => monitored.add(id),
        remove: (id) => monitored.delete(id),
        dispose: () => monitored.clear(),
      };
    },
    keys: options.keys ?? null,
    prefs: { ...DEFAULT_PREFS, ...options.prefs },
    savePrefs: (prefs) => saved.push(prefs),
    loadVolume: (userId) => volumes.get(userId) ?? 1,
    saveVolume: (userId, volume) => volumes.set(userId, volume),
  });
  client.start();
  return {
    client,
    signal,
    media,
    devices,
    output,
    playing,
    monitored,
    saved,
    volumes,
    speak: (id: string, speaking: boolean) => speak(id, speaking),
    mic: () => devices.mics.at(-1) as FakeMicTrack,
  };
}
