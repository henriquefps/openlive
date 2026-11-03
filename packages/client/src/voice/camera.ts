// SPDX-License-Identifier: AGPL-3.0-only
import { CAMERA_LAYERS } from '@openlive/usage';
import type { ErrorInput } from '../api/client.ts';
import type { SignalVoice } from '../room/connection.ts';
import type { MsidLink, Publication } from '../rtc/session.ts';
import {
  type DeviceInfoLike,
  type DevicesLike,
  type DeviceOption,
  errorNameOf,
  type MediaStreamLike,
  type MediaTrackLike,
  type UserMediaConstraints,
  type VoiceSignal,
} from './client.ts';
import type { CameraStopReason, CameraTrack } from './contract.ts';

// The camera in the voice channel (PROTOCOL 7.7): one per
// room page, beside the voice client. Turning it on asks for the camera, then publishes one
// simulcast video (360p at ~500 kbps and 180p at ~150 kbps) on the room's SFU session. Everyone
// else's camera is pulled on the low layer for small tiles; the enlarged one and the ones the stage
// shows large (setHighLayers) are switched to the high layer (tracks/update, no renegotiation). Each camera plays in one msid stream with its owner's
// microphone, so the two stay in sync.
//
// Voice comes first on a bad network: `setNetwork('poor')` sends and receives the
// low layer only, `'bad'` pauses this camera and stops pulling the others', and the voice is left
// alone. Every dependency is an interface, so the state machine runs against fakes in tests.

/** The camera side of the room's SFU session (voice/camera-media.ts). */
export interface CameraMedia<T extends MediaTrackLike = MediaTrackLike> {
  /** Publishes the camera with its simulcast layers; refused codes come back as ApiError. */
  publish(track: T): Promise<Publication<T>>;
  unpublish(publication: Publication<T>): Promise<void>;
  /** Stops sending here only: the room already closed the camera (stopped, out of voice). */
  drop(publication: Publication<T>): Promise<void>;
  /** Pulls the cameras on the strip's layer (at most four per SFU request), by trackId. */
  pull(cameras: readonly CameraTrack[], owner: object): Promise<Map<string, T>>;
  unpull(trackIds: readonly string[], owner: object): Promise<void>;
  /** Switches a pulled camera's layer (tracks/update). */
  setLayer(trackId: string, rid: string): Promise<void>;
  /** Which pulled camera plays with which pulled microphone (lip sync). */
  link(links: readonly MsidLink[]): void;
  /** The session was replaced: publish and pull again. */
  onReset(listener: () => void): () => void;
}

export type CameraPhase = 'off' | 'starting' | 'on';
/** Why there is no camera: the person stays in voice without it. */
export type CameraError = 'denied' | 'no_device' | 'device_lost' | 'unsupported' | 'failed';
/** Measured from the session (voice/network.ts): voice keeps priority as it gets worse. */
export type NetworkQuality = 'good' | 'poor' | 'bad';
export type Facing = 'user' | 'environment';

export interface CameraClientState<T extends MediaTrackLike = MediaTrackLike> {
  phase: CameraPhase;
  error: CameraError | null;
  /** The proxy refused: camera limit, not allowed, quota, capability. */
  refused: ErrorInput | null;
  /** Why the room last turned this camera off. */
  stopped: CameraStopReason | null;
  /** This person's own camera, for the "you're on camera" preview. */
  preview: T | null;
  /** Front or back camera on phones; with `inputId` '' it picks the device. */
  facing: Facing;
  inputs: DeviceOption[];
  inputId: string;
  /** The others' cameras, by user id. */
  remote: Record<string, T>;
  /** The person whose camera is enlarged (high layer), if any. */
  enlarged: string | null;
  /** Whose cameras are shown large enough for the high layer (the stage's tile sizes). */
  high: readonly string[];
  network: NetworkQuality;
}

export interface CameraPrefs {
  inputId: string;
  facing: Facing;
}

export const DEFAULT_CAMERA_PREFS: CameraPrefs = { inputId: '', facing: 'user' };

export interface CameraClientOptions<T extends MediaTrackLike = MediaTrackLike> {
  signal: VoiceSignal;
  media: CameraMedia<T>;
  devices: DevicesLike<T> | null;
  prefs?: CameraPrefs;
  savePrefs?: (prefs: CameraPrefs) => void;
}

/** The strip's layer and the enlarged one (PROTOCOL 7.7). */
export const LAYER_LOW = 'l';
export const LAYER_HIGH = 'h';

/** 640×360 at 30 fps; a phone starts on its front camera. */
export function cameraConstraints(inputId: string, facing: Facing): UserMediaConstraints {
  return {
    audio: false,
    video: {
      width: { ideal: CAMERA_LAYERS.h.width },
      height: { ideal: CAMERA_LAYERS.h.height },
      frameRate: { ideal: CAMERA_LAYERS.h.fps, max: CAMERA_LAYERS.h.fps },
      ...(inputId ? { deviceId: { exact: inputId } } : { facingMode: facing }),
    },
  };
}

/** The two simulcast layers, highest first, as the room expects them (rids h and l). */
export interface CameraEncoding {
  rid: string;
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy?: number;
}

export const CAMERA_ENCODINGS: CameraEncoding[] = [
  { rid: LAYER_HIGH, maxBitrate: CAMERA_LAYERS.h.kbps * 1000, maxFramerate: CAMERA_LAYERS.h.fps },
  {
    rid: LAYER_LOW,
    scaleResolutionDownBy: CAMERA_LAYERS.h.height / CAMERA_LAYERS.l.height,
    maxBitrate: CAMERA_LAYERS.l.kbps * 1000,
    maxFramerate: CAMERA_LAYERS.l.fps,
  },
];

export function cameraErrorOf(error: unknown): CameraError {
  const name = errorNameOf(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no_device';
    default:
      return 'failed';
  }
}

/** The proxy's refusal (ApiError body), if it is one. */
function refusalOf(error: unknown): ErrorInput | null {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === 'string' ? (body as ErrorInput) : null;
}

/** The room tells why it refused, and nothing is retried on these. */
const REFUSALS = new Set([
  'camera_limit_reached',
  'camera_not_allowed',
  'quota_exhausted',
  'capability_disabled',
  'voice_not_joined',
]);

const KEY = 'openlive.camera';

/** Where the camera choice is remembered (localStorage on the web, the app's store). */
export interface CameraPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): CameraPrefsStorage | null {
  try {
    return (globalThis as { localStorage?: CameraPrefsStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadCameraPrefs(store: CameraPrefsStorage | null = storage()): CameraPrefs {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_CAMERA_PREFS;
    const value = JSON.parse(raw) as Partial<CameraPrefs>;
    return {
      inputId: typeof value.inputId === 'string' ? value.inputId : '',
      facing: value.facing === 'environment' ? 'environment' : 'user',
    };
  } catch {
    return DEFAULT_CAMERA_PREFS;
  }
}

export function saveCameraPrefs(
  prefs: CameraPrefs,
  store: CameraPrefsStorage | null = storage(),
): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage missing or full: the choice lasts for this page only.
  }
}

export class CameraClient<T extends MediaTrackLike = MediaTrackLike> {
  private state: CameraClientState<T>;
  private readonly listeners = new Set<() => void>();
  private readonly signal: VoiceSignal;
  private readonly media: CameraMedia<T>;
  private readonly devices: DevicesLike<T> | null;
  private readonly persist: (prefs: CameraPrefs) => void;
  private prefs: CameraPrefs;
  private track: T | null = null;
  private publication: Publication<T> | null = null;
  /** The person wants the camera on: published again after a reconnect or a session reset. */
  private wanted = false;
  /** Bumped by every stop: async work started before it must not touch the new state. */
  private generation = 0;
  private publishing = false;
  /** The last voice.cameraStopped seen (they are numbered by the room connection). */
  private stopSeq = 0;
  /** Pulled cameras by trackId. */
  private readonly pulled = new Map<string, { userId: string; track: T }>();
  /** The layer each pulled camera is on, by trackId. */
  private readonly layers = new Map<string, string>();
  private syncing = false;
  private syncAgain = false;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly owner = {};

  constructor(options: CameraClientOptions<T>) {
    this.signal = options.signal;
    this.media = options.media;
    this.devices = options.devices;
    this.prefs = options.prefs ?? DEFAULT_CAMERA_PREFS;
    this.persist = options.savePrefs ?? saveCameraPrefs;
    this.state = {
      phase: 'off',
      error: null,
      refused: null,
      stopped: null,
      preview: null,
      facing: this.prefs.facing,
      inputs: [],
      inputId: this.prefs.inputId,
      remote: {},
      enlarged: null,
      high: [],
      network: 'good',
    };
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.stopSeq = this.signal.getVoice().cameraStopped?.seq ?? 0;
    this.unsubscribers.push(this.signal.subscribe(() => this.onSignal()));
    this.unsubscribers.push(this.media.onReset(() => this.onSessionReset()));
    if (this.devices) {
      const onDeviceChange = () => void this.refreshDevices();
      this.devices.addEventListener('devicechange', onDeviceChange);
      this.unsubscribers.push(() =>
        this.devices?.removeEventListener('devicechange', onDeviceChange),
      );
    }
    this.onSignal();
  }

  stop(): void {
    this.turnOff();
    this.dropPulls(true);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  getState = (): CameraClientState<T> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Turn the camera on: in voice, with canUseCamera. The permission prompt comes first. */
  async turnOn(): Promise<void> {
    const voice = this.signal.getVoice();
    if (this.state.phase !== 'off' || voice.self !== 'in' || !voice.canUseCamera) return;
    this.wanted = true;
    this.set({ phase: 'starting', error: null, refused: null, stopped: null });
    const generation = this.generation;
    const track = await this.openCamera();
    if (generation !== this.generation) {
      track?.stop();
      return;
    }
    if (!track) {
      this.wanted = false;
      this.set({ phase: 'off' });
      return;
    }
    this.track = track;
    this.set({ preview: track });
    await this.publish();
  }

  /** Turn the camera off: unpublished, and the device light goes out. */
  turnOff(): void {
    this.wanted = false;
    this.stopLocal(true);
  }

  async toggle(): Promise<void> {
    if (this.state.phase === 'off') await this.turnOn();
    else this.turnOff();
  }

  /** Enlarge someone's camera (high layer) or close the enlarged one (null). */
  enlarge(userId: string | null): void {
    if (userId === this.state.enlarged) return;
    this.set({ enlarged: userId });
    this.applyLayers();
  }

  /**
   * The cameras shown large enough for the high layer (stage-layout.ts pickHighLayers), besides
   * the enlarged one. Only on a good network: poor and bad keep everyone on the low layer.
   */
  setHighLayers(userIds: Iterable<string>): void {
    const high = [...new Set(userIds)].sort();
    if (high.join() === [...this.state.high].sort().join()) return;
    this.set({ high });
    this.applyLayers();
  }

  /** The network got worse or better: cameras step down (or pause) before the voice does. */
  setNetwork(network: NetworkQuality): void {
    if (network === this.state.network) return;
    this.set({ network });
    void this.applySendLayers();
    this.applyLayers();
    void this.syncPulls();
  }

  /** Another camera: swapped on the published track, with no renegotiation. */
  async setInput(deviceId: string): Promise<void> {
    this.savePrefs({ inputId: deviceId });
    this.set({ inputId: deviceId });
    await this.reopen();
  }

  /** Phones: the front or the back camera. */
  async flip(): Promise<void> {
    const facing: Facing = this.state.facing === 'user' ? 'environment' : 'user';
    this.savePrefs({ facing, inputId: '' });
    this.set({ facing, inputId: '' });
    await this.reopen();
  }

  /** Lists cameras (labels only show once the camera was allowed). */
  async refreshDevices(): Promise<void> {
    if (!this.devices) return;
    try {
      const all = await this.devices.enumerateDevices();
      this.set({
        inputs: all
          .filter((d: DeviceInfoLike) => d.kind === 'videoinput' && d.deviceId !== '')
          .map((d: DeviceInfoLike, i: number) => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${i + 1}`,
          })),
      });
    } catch {
      // The list stays as it was.
    }
  }

  dismiss(): void {
    this.set({ error: null, refused: null, stopped: null });
  }

  // --- internals ---

  private set(patch: Partial<CameraClientState<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private savePrefs(patch: Partial<CameraPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    this.persist(this.prefs);
  }

  private async openCamera(): Promise<T | null> {
    if (!this.devices) {
      this.set({ error: 'unsupported' });
      return null;
    }
    let stream: MediaStreamLike<T>;
    try {
      stream = await this.devices.getUserMedia(
        cameraConstraints(this.state.inputId, this.state.facing),
      );
    } catch (error) {
      // The remembered camera is gone: the default one instead.
      if (this.state.inputId !== '' && cameraErrorOf(error) === 'no_device') {
        try {
          stream = await this.devices.getUserMedia(cameraConstraints('', this.state.facing));
        } catch (retry) {
          this.set({ error: cameraErrorOf(retry) });
          return null;
        }
      } else {
        this.set({ error: cameraErrorOf(error) });
        return null;
      }
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      this.set({ error: 'no_device' });
      return null;
    }
    // Unplugged, or taken by the system: the camera turns off, the voice goes on.
    track.addEventListener('ended', () => {
      if (track !== this.track) return;
      this.turnOff();
      this.set({ error: 'device_lost' });
    });
    void this.refreshDevices();
    return track;
  }

  private async reopen(): Promise<void> {
    if (this.state.phase === 'off' || !this.track) return;
    const generation = this.generation;
    const previous = this.track;
    const next = await this.openCamera();
    if (generation !== this.generation || !next) {
      next?.stop();
      return;
    }
    this.track = next;
    previous.stop();
    this.set({ preview: next });
    if (this.publication) await this.publication.replaceTrack(next).catch(() => undefined);
  }

  private async publish(): Promise<void> {
    const track = this.track;
    if (!track || this.publication || this.publishing || !this.wanted) return;
    if (this.signal.getVoice().self !== 'in') return;
    const generation = this.generation;
    this.publishing = true;
    try {
      const publication = await this.media.publish(track);
      if (generation !== this.generation || !this.wanted) {
        void this.media.unpublish(publication);
        return;
      }
      this.publication = publication;
      if (this.track !== track && this.track) {
        await publication.replaceTrack(this.track).catch(() => undefined);
      }
      this.set({ phase: 'on' });
      await this.applySendLayers();
    } catch (error) {
      if (generation !== this.generation) return;
      const refused = refusalOf(error);
      this.wanted = false;
      this.stopLocal(false);
      if (refused && REFUSALS.has(refused.code)) this.set({ refused });
      else this.set({ error: 'failed' });
    } finally {
      this.publishing = false;
    }
  }

  /** Stops the camera here; `unpublish` also closes it at the SFU (the room may have already). */
  private stopLocal(unpublish: boolean): void {
    this.generation += 1;
    if (this.publication && unpublish) void this.media.unpublish(this.publication);
    else if (this.publication) void this.media.drop(this.publication);
    this.publication = null;
    this.track?.stop();
    this.track = null;
    if (this.state.phase !== 'off' || this.state.preview) this.set({ phase: 'off', preview: null });
  }

  /** What this camera sends: both layers, the low one only, or nothing (voice first). */
  private async applySendLayers(): Promise<void> {
    const { network } = this.state;
    await this.publication
      ?.setActiveLayers((rid) => network === 'good' || (network === 'poor' && rid !== LAYER_HIGH))
      .catch(() => undefined);
  }

  /** Every pulled camera on the strip's layer, but the enlarged and the large ones on a good
   * network. */
  private applyLayers(): void {
    const voice = this.signal.getVoice();
    for (const [trackId, { userId }] of this.pulled) {
      const camera = voice.cameras.find((c) => c.trackId === trackId);
      if (!camera || camera.rids.length < 2) continue;
      const large = userId === this.state.enlarged || this.state.high.includes(userId);
      const rid = large && this.state.network === 'good' ? LAYER_HIGH : LAYER_LOW;
      if ((this.layers.get(trackId) ?? LAYER_LOW) === rid) continue;
      this.layers.set(trackId, rid);
      void this.media.setLayer(trackId, rid).catch(() => undefined);
    }
  }

  private onSignal(): void {
    const voice = this.signal.getVoice();
    const stop = voice.cameraStopped;
    if (stop && stop.seq > this.stopSeq) {
      this.stopSeq = stop.seq;
      // The room closed it already: nothing to unpublish.
      this.wanted = false;
      this.stopLocal(false);
      this.set({ stopped: stop.reason });
    }
    if (voice.self !== 'in') {
      // Out of voice (or the socket dropped): the room closed the camera and the pulls.
      if (voice.self === 'out') this.wanted = false;
      const wanted = this.wanted;
      this.stopLocal(false);
      this.wanted = wanted;
      this.dropPulls(voice.self === 'out');
      if (this.state.enlarged !== null) this.set({ enlarged: null });
      return;
    }
    if (!voice.canUseCamera && this.state.phase !== 'off') this.turnOff();
    // Back in voice after a reconnect: the camera comes back if it was on.
    if (this.wanted && this.state.phase === 'off' && !this.publishing) {
      this.wanted = false;
      void this.turnOn();
    }
    const enlarged = this.state.enlarged;
    if (enlarged !== null && !voice.cameras.some((c) => c.userId === enlarged)) {
      this.set({ enlarged: null });
    }
    void this.syncPulls();
  }

  private links(voice: SignalVoice): MsidLink[] {
    return voice.cameras.flatMap((c) => {
      const audio = voice.tracks.find((t) => t.userId === c.userId)?.trackId;
      return audio ? [{ video: c.trackId, audio }] : [];
    });
  }

  /** Pulls who turned a camera on and drops who turned it off, one run at a time. */
  private async syncPulls(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        const voice = this.signal.getVoice();
        if (voice.self !== 'in') return;
        this.media.link(this.links(voice));
        // A bad network pulls no camera at all: voice first.
        const wanted =
          this.state.network === 'bad'
            ? []
            : voice.cameras.filter((c) => c.userId !== voice.selfId);
        const gone = [...this.pulled.keys()].filter((id) => !wanted.some((c) => c.trackId === id));
        if (gone.length > 0) {
          for (const id of gone) this.forget(id);
          await this.media.unpull(gone, this.owner);
        }
        const added = wanted.filter((c) => !this.pulled.has(c.trackId));
        if (added.length === 0) continue;
        let tracks: Map<string, T>;
        try {
          tracks = await this.media.pull(added, this.owner);
        } catch {
          // A session reset pulls everything again; anything else is tried on the next change.
          continue;
        }
        const still = this.signal.getVoice();
        if (still.self !== 'in') return;
        for (const c of added) {
          const track = tracks.get(c.trackId);
          if (!track) continue;
          this.pulled.set(c.trackId, { userId: c.userId, track });
          this.layers.set(c.trackId, LAYER_LOW);
        }
        this.publishRemote();
        this.applyLayers();
      } while (this.syncAgain);
    } finally {
      this.syncing = false;
    }
  }

  private publishRemote(): void {
    const remote: Record<string, T> = {};
    for (const { userId, track } of this.pulled.values()) remote[userId] = track;
    this.set({ remote });
  }

  private forget(trackId: string): void {
    this.pulled.delete(trackId);
    this.layers.delete(trackId);
    this.publishRemote();
  }

  /** Forgets every pulled camera here; `close` also closes them at the SFU. */
  private dropPulls(close: boolean): void {
    const ids = [...this.pulled.keys()];
    if (ids.length === 0) return;
    for (const id of ids) {
      this.pulled.delete(id);
      this.layers.delete(id);
    }
    this.publishRemote();
    if (close) void this.media.unpull(ids, this.owner);
  }

  private onSessionReset(): void {
    // The old session took the publication and the pulls with it.
    this.publication = null;
    this.dropPulls(false);
    if (this.wanted && this.track) void this.publish();
    void this.syncPulls();
  }
}
