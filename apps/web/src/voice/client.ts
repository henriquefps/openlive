// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorInput } from '../i18n/errors.ts';
import type { Publication } from '../rtc/session.ts';
import type {
  CameraStopReason,
  CameraTrack,
  VoiceLeftReason,
  VoiceParticipant,
  VoiceTrack,
} from './contract.ts';
import {
  clampPersonVolume,
  loadPersonVolume,
  loadPrefs,
  savePersonVolume,
  savePrefs,
  type VoicePrefs,
} from './prefs.ts';
import { findVoiceSinkDevice } from './voice-sink.ts';

// The voice client: one per room page. Join asks for the
// microphone, joins on the room socket, publishes one Opus track on the room's SFU session and
// pulls everyone else's microphone as the room lists them (`voice.tracks`). Mute and push-to-talk
// only switch the track off (`enabled = false`): no renegotiation. Deafen silences every voice
// locally and mutes the microphone, and gives the previous mute back when lifted. Who is speaking
// is measured here, from the audio itself; nothing about it goes to the server.
//
// Every dependency is an interface (the room socket, the SFU session, the media devices, the
// speakers and the level meter), so the state machine runs against fakes in tests.

/** The voice part of the room socket (room/connection.ts). */
export interface VoiceSignal {
  getVoice(): SignalVoice;
  subscribe(listener: () => void): () => void;
  join(state: { muted: boolean; deafened: boolean }): void;
  leave(): void;
  setState(state: { muted: boolean; deafened: boolean }): void;
}

export interface SignalVoice {
  /** This connection: out of voice, asked to join, or in. */
  self: 'out' | 'joining' | 'in';
  selfId: string | null;
  /** May publish a microphone (Permissions.canSpeak); listening only otherwise. */
  canSpeak: boolean;
  participants: VoiceParticipant[];
  /** The others' microphones to pull (only while in voice). */
  tracks: VoiceTrack[];
  /** The others' cameras to pull (only while in voice; since 1.12). */
  cameras: CameraTrack[];
  /** May turn a camera on (Permissions.canUseCamera). */
  canUseCamera: boolean;
  /** The room last turned this person's camera off: why, numbered so a repeat is seen. */
  cameraStopped: { reason: CameraStopReason; seq: number } | null;
  /** The room refused to let this connection join (voice_full, capability_disabled, …). */
  error: ErrorInput | null;
  /** Why the room last took this connection out, when it did. */
  left: VoiceLeftReason | null;
}

/** The voice side of the room's SFU session (voice/media.ts). */
export interface VoiceMedia {
  publish(track: MediaStreamTrack): Promise<Publication>;
  unpublish(publication: Publication): Promise<void>;
  /** Pulls the tracks (at most four per SFU request), by trackId. */
  pull(tracks: readonly VoiceTrack[], owner: object): Promise<Map<string, MediaStreamTrack>>;
  unpull(trackIds: readonly string[], owner: object): Promise<void>;
  /** The session was replaced: publish and pull again. */
  onReset(listener: () => void): () => void;
}

/** navigator.mediaDevices, or a fake. */
export interface DevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
}

/** Plays the others' voices (voice/audio.ts). */
export interface VoiceOutput {
  attach(userId: string, track: MediaStreamTrack, volume: number): void;
  detach(userId: string): void;
  setVolume(userId: string, volume: number): void;
  setDeafened(deafened: boolean): void;
  /** Picks the speakers; false where the browser cannot (no setSinkId). */
  setSink(deviceId: string): Promise<boolean>;
  readonly canPickSink: boolean;
  /** Called from the join click: lets audio start (autoplay rules). */
  resume(): void;
  dispose(): void;
}

/** Tells, from the audio, who is speaking (voice/levels.ts). */
export interface SpeakingMonitor {
  add(id: string, track: MediaStreamTrack): void;
  remove(id: string): void;
  dispose(): void;
}

export type VoicePhase = 'idle' | 'joining' | 'joined';

/** Why there is no microphone: the person is in voice listening only. */
export type MicError = 'denied' | 'no_device' | 'device_lost' | 'unsupported' | 'failed';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface VoiceClientState {
  phase: VoicePhase;
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;
  /** The push-to-talk key is held. */
  pttPressed: boolean;
  /** The microphone is sending sound right now. */
  transmitting: boolean;
  micError: MicError | null;
  /** The room or the proxy refused: voice full, voice off, not allowed to speak. */
  error: ErrorInput | null;
  /** Why the room took this person out of voice. */
  removed: Exclude<VoiceLeftReason, 'left' | 'disconnected'> | null;
  /** Speaking now, by user id (this person included while transmitting). */
  speaking: Record<string, boolean>;
  /** Each person's volume, 0–2, for the people in voice. */
  volumes: Record<string, number>;
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  inputId: string;
  outputId: string;
  canPickOutput: boolean;
  /**
   * The voice sink's deviceId while voice plays into it (voice-sink.ts); null while
   * voice plays on `outputId` (no helper sink, no setSinkId, the label not found).
   */
  voiceSinkId: string | null;
}

export interface VoiceClientOptions {
  signal: VoiceSignal;
  media: VoiceMedia;
  devices: DevicesLike | null;
  output: VoiceOutput;
  createMonitor: (onChange: (id: string, speaking: boolean) => void) => SpeakingMonitor;
  /** Where push-to-talk listens for keys: the window (only while the tab has focus). */
  keys?: EventTarget | null;
  prefs?: VoicePrefs;
  savePrefs?: (prefs: VoicePrefs) => void;
  loadVolume?: (userId: string) => number;
  saveVolume?: (userId: string, volume: number) => void;
}

/** What the browser does to the microphone before it is sent. */
export function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

export function micErrorOf(error: unknown): MicError {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
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

const errorCodeOf = (error: unknown): string | null => {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === 'string' ? body.code : null;
};

/** Typing in a field never triggers push-to-talk. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

const SELF = 'self';

export class VoiceClient {
  private state: VoiceClientState;
  private readonly listeners = new Set<() => void>();
  private readonly signal: VoiceSignal;
  private readonly media: VoiceMedia;
  private readonly devices: DevicesLike | null;
  private readonly output: VoiceOutput;
  private readonly monitor: SpeakingMonitor;
  private readonly keys: EventTarget | null;
  private readonly persist: (prefs: VoicePrefs) => void;
  private readonly loadVolume: (userId: string) => number;
  private readonly saveVolume: (userId: string, volume: number) => void;
  private prefs: VoicePrefs;
  /** The microphone, while there is one. */
  private mic: MediaStreamTrack | null = null;
  private publication: Publication | null = null;
  /** Mute before deafen, given back when deafen is lifted. */
  private mutedBeforeDeafen = false;
  /** Pulled tracks by trackId: whose they are and the track. */
  private readonly pulled = new Map<string, { userId: string; track: MediaStreamTrack }>();
  /** Bumped by leave(): async work started before it must not touch the new state. */
  private generation = 0;
  private syncing = false;
  private syncAgain = false;
  private publishing = false;
  /** voice.join was sent: from then on the room's answer counts. */
  private asked = false;
  private readonly unsubscribers: (() => void)[] = [];
  /** The pulls' owner on the shared session (another owner's pulls are not closed by this one). */
  private readonly owner = {};
  /** The helper's voice sink label, while one of the user's helpers has one. */
  private voiceSinkLabel: string | null = null;
  /** The output voice plays on now ('' the default), so it is set only when it changes. */
  private sink = '';
  /** Bumped by each route(): an older lookup must not override a newer one. */
  private routing = 0;

  constructor(options: VoiceClientOptions) {
    this.signal = options.signal;
    this.media = options.media;
    this.devices = options.devices;
    this.output = options.output;
    this.keys = options.keys === undefined ? null : options.keys;
    this.prefs = options.prefs ?? loadPrefs();
    this.persist = options.savePrefs ?? ((prefs) => savePrefs(prefs));
    this.loadVolume = options.loadVolume ?? ((userId) => loadPersonVolume(userId));
    this.saveVolume = options.saveVolume ?? ((userId, volume) => savePersonVolume(userId, volume));
    this.monitor = options.createMonitor((id, speaking) => this.onSpeaking(id, speaking));
    this.state = {
      phase: 'idle',
      muted: false,
      deafened: false,
      serverMuted: false,
      pushToTalk: this.prefs.pushToTalk,
      pushToTalkKey: this.prefs.pushToTalkKey,
      pttPressed: false,
      transmitting: false,
      micError: null,
      error: null,
      removed: null,
      speaking: {},
      volumes: {},
      inputs: [],
      outputs: [],
      inputId: this.prefs.inputId,
      outputId: this.prefs.outputId,
      canPickOutput: this.output.canPickSink,
      voiceSinkId: null,
    };
  }

  /** Listens to the room, the session, the devices and the keys (the room page mounted). */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    void this.route();
    this.unsubscribers.push(this.signal.subscribe(() => this.onSignal()));
    this.unsubscribers.push(this.media.onReset(() => this.onSessionReset()));
    if (this.devices) {
      const onDeviceChange = () => this.onDeviceChange();
      this.devices.addEventListener('devicechange', onDeviceChange);
      this.unsubscribers.push(() =>
        this.devices?.removeEventListener('devicechange', onDeviceChange),
      );
    }
    if (this.keys) {
      const down = (event: Event) => this.onKey(event as KeyboardEvent, true);
      const up = (event: Event) => this.onKey(event as KeyboardEvent, false);
      const blur = () => this.setPttPressed(false);
      this.keys.addEventListener('keydown', down);
      this.keys.addEventListener('keyup', up);
      this.keys.addEventListener('blur', blur);
      this.unsubscribers.push(() => {
        this.keys?.removeEventListener('keydown', down);
        this.keys?.removeEventListener('keyup', up);
        this.keys?.removeEventListener('blur', blur);
      });
    }
  }

  getState = (): VoiceClientState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get prefsSnapshot(): VoicePrefs {
    return this.prefs;
  }

  /** Join voice: microphone first (the permission prompt), then the room, then the SFU. */
  async join(): Promise<void> {
    if (this.state.phase !== 'idle') return;
    const generation = this.generation;
    this.output.resume();
    this.set({ phase: 'joining', error: null, removed: null, micError: null });
    // Someone who may not speak joins to listen, without the permission prompt.
    if (this.signal.getVoice().canSpeak) await this.openMic();
    if (generation !== this.generation) return;
    void this.refreshDevices();
    this.asked = true;
    this.signal.join({ muted: this.state.muted, deafened: this.state.deafened });
    this.onSignal();
  }

  /** Leave voice: the microphone stops, everything pulled is closed. */
  leave(): void {
    if (this.state.phase === 'idle') return;
    this.signal.leave();
    this.teardown();
  }

  setMuted(muted: boolean): void {
    if (!muted && this.state.deafened) {
      // Unmuting while deafened lifts deafen too (as on Discord).
      this.mutedBeforeDeafen = false;
      this.setDeafened(false);
      return;
    }
    this.set({ muted });
    this.announce();
  }

  setDeafened(deafened: boolean): void {
    if (deafened === this.state.deafened) return;
    if (deafened) {
      this.mutedBeforeDeafen = this.state.muted;
      this.set({ deafened: true, muted: true });
    } else {
      this.set({ deafened: false, muted: this.mutedBeforeDeafen });
    }
    this.output.setDeafened(deafened);
    this.announce();
  }

  setPushToTalk(enabled: boolean, key: string = this.state.pushToTalkKey): void {
    this.savePrefs({ pushToTalk: enabled, pushToTalkKey: key });
    this.set({ pushToTalk: enabled, pushToTalkKey: key, pttPressed: false });
  }

  /** Push-to-talk from a button (touch screens) or the key. */
  setPttPressed(pressed: boolean): void {
    if (pressed === this.state.pttPressed) return;
    this.set({ pttPressed: pressed });
  }

  setVolume(userId: string, volume: number): void {
    const value = clampPersonVolume(volume);
    this.saveVolume(userId, value);
    this.output.setVolume(userId, value);
    this.set({ volumes: { ...this.state.volumes, [userId]: value } });
  }

  /** Another microphone: swapped on the published track, with no renegotiation. */
  async setInput(deviceId: string): Promise<void> {
    this.savePrefs({ inputId: deviceId });
    this.set({ inputId: deviceId });
    if (this.state.phase === 'idle') return;
    const generation = this.generation;
    const previous = this.mic;
    this.mic = null;
    await this.openMic();
    if (generation !== this.generation) return;
    if (previous) {
      this.monitor.remove(SELF);
      previous.stop();
    }
    await this.afterMicChange();
  }

  /**
   * Another output. While voice plays into the voice sink it stays there: the helper plays the
   * sink on this output instead (helper.setVoiceOutput, sent by VoiceSinkRouting).
   */
  async setOutput(deviceId: string): Promise<void> {
    this.savePrefs({ outputId: deviceId });
    this.set({ outputId: deviceId });
    await this.route();
  }

  /** The voice sink one of the user's helpers reports (its label), or null. */
  setVoiceSinkLabel(label: string | null): void {
    if (label === this.voiceSinkLabel) return;
    this.voiceSinkLabel = label;
    void this.route();
  }

  dismissHeadphonesHint(): void {
    this.savePrefs({ headphonesHintDismissed: true });
  }

  /** Lists microphones and speakers (labels only show once the microphone was allowed). */
  async refreshDevices(): Promise<void> {
    if (!this.devices) return;
    try {
      const all = await this.devices.enumerateDevices();
      const option = (d: MediaDeviceInfo, i: number): DeviceOption => ({
        deviceId: d.deviceId,
        label: d.label || `${d.kind === 'audioinput' ? 'Microphone' : 'Speakers'} ${i + 1}`,
      });
      const real = (d: MediaDeviceInfo) => d.deviceId !== '' && d.deviceId !== 'default';
      const sinkId = this.voiceSinkLabel ? findVoiceSinkDevice(all, this.voiceSinkLabel) : null;
      this.set({
        inputs: all.filter((d) => d.kind === 'audioinput' && real(d)).map(option),
        // The voice sink is not speakers to pick: it plays on the picked ones.
        outputs: all
          .filter((d) => d.kind === 'audiooutput' && real(d) && d.deviceId !== sinkId)
          .map(option),
      });
      // Labels appear once the microphone is allowed: the voice sink may be findable now.
      if (this.output.canPickSink && this.voiceSinkLabel && sinkId !== this.state.voiceSinkId) {
        void this.route();
      }
    } catch {
      // The lists stay as they were.
    }
  }

  /** Leaves voice and stops listening (the room page went away); `start()` again is fine. */
  stop(): void {
    this.leave();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.monitor.dispose();
    this.output.dispose();
  }

  // --- internals ---

  /**
   * Plays voice into the voice sink when there is one this browser can pick, else on the chosen
   * output (setSinkId where the browser has it; Firefox and Safari keep the default).
   */
  private async route(): Promise<void> {
    const routing = ++this.routing;
    let sinkId: string | null = null;
    if (this.voiceSinkLabel && this.output.canPickSink && this.devices) {
      try {
        sinkId = findVoiceSinkDevice(await this.devices.enumerateDevices(), this.voiceSinkLabel);
      } catch {
        sinkId = null;
      }
      if (routing !== this.routing) return;
    }
    const target = sinkId ?? this.prefs.outputId;
    if (target !== this.sink) {
      this.sink = target;
      await this.output.setSink(target);
      if (routing !== this.routing) return;
    }
    if (sinkId !== this.state.voiceSinkId) this.set({ voiceSinkId: sinkId });
  }

  private set(patch: Partial<VoiceClientState>): void {
    const next = { ...this.state, ...patch };
    next.transmitting =
      next.phase === 'joined' &&
      this.mic !== null &&
      this.publication !== null &&
      !next.muted &&
      !next.deafened &&
      !next.serverMuted &&
      (!next.pushToTalk || next.pttPressed);
    if (this.mic) this.mic.enabled = next.transmitting;
    if (!next.transmitting && next.speaking[this.selfId()]) {
      next.speaking = { ...next.speaking, [this.selfId()]: false };
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private savePrefs(patch: Partial<VoicePrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    this.persist(this.prefs);
  }

  private selfId(): string {
    return this.signal.getVoice().selfId ?? SELF;
  }

  /** Tells the room this person's mute and deafen (everyone sees the icons). */
  private announce(): void {
    if (this.state.phase !== 'joined') return;
    this.signal.setState({ muted: this.state.muted, deafened: this.state.deafened });
  }

  private async openMic(): Promise<void> {
    if (!this.devices) {
      this.set({ micError: 'unsupported' });
      return;
    }
    const generation = this.generation;
    let stream: MediaStream;
    try {
      stream = await this.devices.getUserMedia(micConstraints(this.state.inputId));
    } catch (error) {
      // The remembered microphone is gone: the default one instead.
      if (this.state.inputId !== '' && micErrorOf(error) === 'no_device') {
        try {
          stream = await this.devices.getUserMedia(micConstraints(''));
        } catch (retry) {
          if (generation === this.generation) this.set({ micError: micErrorOf(retry) });
          return;
        }
      } else {
        if (generation === this.generation) this.set({ micError: micErrorOf(error) });
        return;
      }
    }
    const track = stream.getAudioTracks()[0];
    if (generation !== this.generation || !track) {
      for (const t of stream.getTracks()) t.stop();
      if (!track && generation === this.generation) this.set({ micError: 'no_device' });
      return;
    }
    // Unplugged, or taken away by the system: listen only until a microphone is back.
    track.addEventListener('ended', () => this.onMicEnded(track));
    this.mic = track;
    this.monitor.add(SELF, track);
    this.set({ micError: null });
  }

  private onMicEnded(track: MediaStreamTrack): void {
    if (track !== this.mic) return;
    this.mic = null;
    this.monitor.remove(SELF);
    this.set({ micError: 'device_lost' });
    if (this.publication) void this.publication.replaceTrack(null).catch(() => undefined);
    // Maybe another microphone is still there (the default one).
    void this.recoverMic();
  }

  private async recoverMic(): Promise<void> {
    if (this.state.phase === 'idle' || this.mic) return;
    const generation = this.generation;
    const inputId = this.state.inputId;
    this.set({ inputId: '' });
    await this.openMic();
    if (generation !== this.generation) return;
    if (!this.mic) {
      this.set({ inputId, micError: this.state.micError ?? 'device_lost' });
      return;
    }
    await this.afterMicChange();
  }

  /** A new microphone: on the published track, or published now (it was listen-only). */
  private async afterMicChange(): Promise<void> {
    if (!this.mic || this.state.phase !== 'joined') {
      this.set({});
      return;
    }
    if (this.publication) {
      await this.publication.replaceTrack(this.mic).catch(() => undefined);
      this.set({});
    } else {
      await this.publish();
    }
  }

  private onDeviceChange(): void {
    void this.refreshDevices();
    if (this.state.phase !== 'idle' && !this.mic && this.state.micError !== 'denied') {
      void this.recoverMic();
    }
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (!this.state.pushToTalk || event.code !== this.state.pushToTalkKey) return;
    if (down && (event.repeat || isEditable(event.target))) return;
    this.setPttPressed(down);
  }

  private onSpeaking(id: string, speaking: boolean): void {
    const userId = id === SELF ? this.selfId() : id;
    if (id === SELF && speaking && !this.state.transmitting) return;
    if (Boolean(this.state.speaking[userId]) === speaking) return;
    this.set({ speaking: { ...this.state.speaking, [userId]: speaking } });
  }

  private onSignal(): void {
    const voice = this.signal.getVoice();
    const self = voice.participants.find((p) => p.userId === voice.selfId);
    if (self && self.serverMuted !== this.state.serverMuted) this.onServerMute(self.serverMuted);
    this.syncVolumes(voice.participants);
    if (this.state.phase === 'idle' || !this.asked) return;
    if (voice.self === 'out') {
      // Refused, taken out, or the room is gone; before the first answer `left` is still null.
      if (voice.error === null && voice.left === null) return;
      const { error, left } = voice;
      this.teardown();
      if (error !== null) this.set({ error });
      else if (left !== null && left !== 'left' && left !== 'disconnected') {
        this.set({ removed: left });
      }
      return;
    }
    switch (this.state.phase) {
      case 'joining':
        if (voice.self === 'in') {
          this.set({ phase: 'joined' });
          this.announce();
          void this.publish();
          void this.syncPulls();
        }
        return;
      case 'joined':
        if (voice.self === 'in') {
          void this.syncPulls();
          return;
        }
        // The socket dropped: the room connection joins again once it is back.
        this.set({ phase: 'joining' });
        this.dropPulls();
        if (this.publication) {
          const publication = this.publication;
          this.publication = null;
          void this.media.unpublish(publication);
          this.set({});
        }
        return;
    }
  }

  /**
   * A moderator muted this person: the room closed the microphone track and refuses a new one,
   * so the publication is dropped here too. Lifted: the microphone is published again.
   */
  private onServerMute(serverMuted: boolean): void {
    this.set({ serverMuted });
    if (serverMuted && this.publication) {
      const publication = this.publication;
      this.publication = null;
      void this.media.unpublish(publication);
      this.set({});
    }
    if (!serverMuted && this.state.phase === 'joined') void this.publish();
  }

  private syncVolumes(participants: readonly VoiceParticipant[]): void {
    const missing = participants.filter((p) => !(p.userId in this.state.volumes));
    if (missing.length === 0) return;
    const volumes = { ...this.state.volumes };
    for (const p of missing) volumes[p.userId] = this.loadVolume(p.userId);
    this.set({ volumes });
  }

  private async publish(): Promise<void> {
    const mic = this.mic;
    if (!mic || this.publication || this.publishing || this.state.serverMuted) {
      this.set({});
      return;
    }
    const generation = this.generation;
    this.publishing = true;
    try {
      const publication = await this.media.publish(mic);
      if (generation !== this.generation || this.state.phase !== 'joined') {
        void this.media.unpublish(publication);
        return;
      }
      this.publication = publication;
      // The microphone changed while the offer was on its way.
      if (this.mic !== mic) await publication.replaceTrack(this.mic).catch(() => undefined);
      this.set({});
    } catch (error) {
      if (generation !== this.generation) return;
      const code = errorCodeOf(error);
      if (code === 'voice_speak_not_allowed') {
        // In voice, listening only.
        this.mic?.stop();
        if (this.mic) this.monitor.remove(SELF);
        this.mic = null;
        this.set({ error: { code } });
      } else {
        this.set({ micError: this.state.micError ?? 'failed' });
      }
    } finally {
      this.publishing = false;
    }
  }

  /** Pulls who joined and closes who left, one run at a time (old pulls closed first). */
  private async syncPulls(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    const generation = this.generation;
    try {
      do {
        this.syncAgain = false;
        if (this.state.phase !== 'joined') return;
        const voice = this.signal.getVoice();
        const wanted = voice.tracks.filter((t) => t.userId !== voice.selfId);
        const gone = [...this.pulled.keys()].filter((id) => !wanted.some((t) => t.trackId === id));
        if (gone.length > 0) {
          for (const id of gone) this.forget(id);
          await this.media.unpull(gone, this.owner);
        }
        const added = wanted.filter((t) => !this.pulled.has(t.trackId));
        if (added.length === 0) continue;
        let tracks: Map<string, MediaStreamTrack>;
        try {
          tracks = await this.media.pull(added, this.owner);
        } catch {
          // A session reset pulls everything again; anything else is tried on the next change.
          continue;
        }
        if (generation !== this.generation) return;
        for (const t of added) {
          const track = tracks.get(t.trackId);
          if (!track) continue;
          this.pulled.set(t.trackId, { userId: t.userId, track });
          this.output.attach(t.userId, track, this.state.volumes[t.userId] ?? 1);
          this.monitor.add(t.userId, track);
        }
      } while (this.syncAgain && generation === this.generation);
    } finally {
      this.syncing = false;
    }
  }

  private forget(trackId: string): void {
    const pulled = this.pulled.get(trackId);
    if (!pulled) return;
    this.pulled.delete(trackId);
    this.output.detach(pulled.userId);
    this.monitor.remove(pulled.userId);
    if (this.state.speaking[pulled.userId]) {
      this.set({ speaking: { ...this.state.speaking, [pulled.userId]: false } });
    }
  }

  /** Forgets every pulled track here; the SFU side is closed by the caller (or is gone). */
  private dropPulls(): string[] {
    const ids = [...this.pulled.keys()];
    for (const id of ids) this.forget(id);
    return ids;
  }

  private onSessionReset(): void {
    if (this.state.phase !== 'joined') return;
    // The old session took the publication and the pulls with it.
    this.publication = null;
    this.dropPulls();
    this.set({});
    void this.publish();
    void this.syncPulls();
  }

  private teardown(): void {
    this.generation += 1;
    this.asked = false;
    const ids = this.dropPulls();
    if (ids.length > 0) void this.media.unpull(ids, this.owner);
    if (this.publication) void this.media.unpublish(this.publication);
    this.publication = null;
    if (this.mic) {
      this.monitor.remove(SELF);
      this.mic.stop();
    }
    this.mic = null;
    if (this.state.deafened) this.output.setDeafened(false);
    this.mutedBeforeDeafen = false;
    this.set({
      phase: 'idle',
      deafened: false,
      muted: false,
      serverMuted: false,
      pttPressed: false,
      micError: null,
      speaking: {},
    });
  }
}
