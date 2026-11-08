// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ErrorPayload,
  Message,
  Preset,
  QualityCap,
  RoomSettings,
  SourceKind,
  StreamEndReason,
  StreamInfo,
} from '@openlive/protocol';
import { ApiError, type ErrorInput } from '@openlive/client';
import {
  type BrowserEncodingPlan,
  browserEncodings,
  presetFrameRate,
} from './browser-encodings.ts';
import type { BrowserPublishApi } from './browser-api.ts';

// Streaming from the browser (protocol 1.22, docs/PROTOCOL.md 7.2 and 11.2): the tab
// captures with getDisplayMedia, publishes its own SFU session through the browser routes and
// plays the helper's part on its room socket (stream.announce, stream.update, stream.end,
// stream.stop). One per tab. It lives outside React so a socket reconnect or a re-render does not
// end it; the room's session is held open while live (the 15 s grace covers a reconnect).

/** How often a thumbnail is uploaded (the helper's interval, PROTOCOL 11.3). */
export const THUMBNAIL_EVERY_MS = 10_000;
/** How often the live panel's stats are read. */
export const STATS_EVERY_MS = 2_000;
/** A reply on the room socket that takes longer than this failed. */
const REPLY_TIMEOUT_MS = 15_000;
const THUMBNAIL_WIDTH = 480;

/** What the live panel shows: from getStats, the top layer as sent. */
export interface BrowserStats {
  width: number;
  height: number;
  fps: number;
  sentKbps: number;
  targetKbps: number;
  /** The browser's own reason for sending less (`cpu`, `bandwidth`), when it says so. */
  limitation: string | null;
}

export type BrowserEnd =
  | { kind: 'room'; reason: StreamEndReason }
  /** The streamer stopped it: here, or with the browser's "Stop sharing". */
  | { kind: 'stopped' };

export interface BrowserLiveState {
  phase: 'idle' | 'starting' | 'live' | 'ended';
  roomId: string | null;
  streamId: string | null;
  preset: Preset | null;
  paused: boolean;
  hasAudio: boolean;
  /** What the person picked: a screen captures the whole system's audio where it has any. */
  surface: 'monitor' | 'window' | 'browser' | null;
  stats: BrowserStats | null;
  /** How the last stream ended, until dismissed (the "install the helper" nudge). */
  ended: BrowserEnd | null;
}

export const IDLE: BrowserLiveState = {
  phase: 'idle',
  roomId: null,
  streamId: null,
  preset: null,
  paused: false,
  hasAudio: false,
  surface: null,
  stats: null,
  ended: null,
};

/** The room socket, as the publisher uses it (room/connection.ts). */
export interface PublisherSocket {
  listen: (listener: (message: Message) => void) => () => void;
  sendRequest: (type: string, payload: object) => string | null;
  /** Calls back when the connection ended for good (kicked, room closed, replaced, …). */
  onEnded: (listener: () => void) => () => void;
}

export interface BrowserStartInput {
  roomId: string;
  tabId: string;
  settings: RoomSettings;
  preset: Preset;
  socket: PublisherSocket;
  api: BrowserPublishApi;
  /** Holds the room's session open while live; returns its release. */
  hold: () => () => void;
  /** The stream card's label for each kind of capture, in the streamer's language. */
  labels: Record<'monitor' | 'window' | 'browser', string>;
}

interface Live {
  input: BrowserStartInput;
  media: MediaStream;
  video: MediaStreamTrack;
  pc: RTCPeerConnection;
  sender: RTCRtpSender;
  sfuSessionId: string | null;
  streamId: string | null;
  plan: BrowserEncodingPlan;
  qualityCap: QualityCap | null;
  cleanups: (() => void)[];
  done: boolean;
}

const errorOf = (e: unknown): ErrorInput =>
  e instanceof ApiError
    ? e.body
    : e && typeof e === 'object' && 'code' in e && typeof e.code === 'string'
      ? (e as ErrorInput)
      : { code: 'internal_error' };

/** Whether this browser can capture a screen (desktop browsers; not phones). */
export function canStreamFromBrowser(nav: Navigator | undefined = globalThis.navigator): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
}

/** Codec preferences with H.264 first (every viewer decodes it; the SFU forwards it as is). */
export function h264First<C extends { mimeType: string }>(codecs: readonly C[]): C[] {
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  return [...h264, ...codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')];
}

export class BrowserLive {
  private state: BrowserLiveState = IDLE;
  private readonly listeners = new Set<() => void>();
  private live: Live | null = null;

  getState = (): BrowserLiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<BrowserLiveState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Forgets how the last stream ended (the nudge was dismissed). */
  dismiss(): void {
    if (this.state.phase === 'ended') this.set({ ...IDLE });
    else if (this.state.ended) this.set({ ended: null });
  }

  /**
   * Asks for a screen and goes live. Call it straight from the click: getDisplayMedia needs the
   * user's gesture. Rejects with the error payload when it could not start.
   */
  async start(input: BrowserStartInput): Promise<void> {
    if (this.live || this.state.phase === 'starting') {
      throw { code: 'browser_stream_busy', roomId: input.roomId } satisfies ErrorPayload;
    }
    this.set({ ...IDLE, phase: 'starting', roomId: input.roomId, preset: input.preset });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: presetFrameRate(input.preset) },
          width: { max: 1920 },
          height: { max: 1080 },
        },
        audio: true,
        // Chrome's options (ignored elsewhere): system audio on a screen, never this very tab,
        // and switching what is shared without stopping.
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    } catch {
      // Cancelled in the browser's picker (or not allowed): back to the panel, nothing to show.
      this.set({ ...IDLE });
      return;
    }
    const video = media.getVideoTracks()[0];
    if (!video) {
      for (const t of media.getTracks()) t.stop();
      this.set({ ...IDLE });
      return;
    }
    try {
      await this.publish(input, media, video);
    } catch (e) {
      const error = errorOf(e);
      if (this.live) this.teardown(this.live);
      else for (const t of media.getTracks()) t.stop();
      this.set({ ...IDLE });
      throw error;
    }
  }

  private async publish(input: BrowserStartInput, media: MediaStream, video: MediaStreamTrack) {
    video.contentHint = 'motion';
    const audio = media.getAudioTracks()[0] ?? null;
    const captured = video.getSettings();
    const surface = (captured.displaySurface as BrowserLiveState['surface'] | undefined) ?? null;
    const plan = browserEncodings({
      preset: input.preset,
      captured,
      audio: audio !== null,
      roomCapKbps: input.settings.maxBitrateKbps,
    });
    const { iceServers } = await input.api.ice();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    const videoTransceiver = pc.addTransceiver(video, {
      direction: 'sendonly',
      streams: [media],
      sendEncodings: plan.encodings,
    });
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
    if (codecs && typeof videoTransceiver.setCodecPreferences === 'function') {
      try {
        videoTransceiver.setCodecPreferences(h264First(codecs));
      } catch {
        // A browser that refuses the order still offers H.264.
      }
    }
    const audioTransceiver = audio
      ? pc.addTransceiver(audio, { direction: 'sendonly', streams: [media] })
      : null;
    const live: Live = {
      input,
      media,
      video,
      pc,
      sender: videoTransceiver.sender,
      sfuSessionId: null,
      streamId: null,
      plan,
      qualityCap: null,
      cleanups: [],
      done: false,
    };
    this.live = live;
    // The person stopped sharing from the browser's own bar.
    video.addEventListener('ended', () => void this.stop());
    await pc.setLocalDescription(await pc.createOffer());
    const videoMid = videoTransceiver.mid;
    if (videoMid === null) throw new Error('no mid for the video');
    const published = await input.api.publish({
      tabId: input.tabId,
      sessionDescription: { type: 'offer', sdp: pc.localDescription?.sdp ?? '' },
      tracks: [
        {
          mid: videoMid,
          trackName: 'video',
          kind: 'video',
          rids: plan.encodings.map((e) => e.rid),
        },
        ...(audioTransceiver?.mid != null
          ? [{ mid: audioTransceiver.mid, trackName: 'audio', kind: 'audio' as const }]
          : []),
      ],
      preset: input.preset,
      maxBitrateKbps: plan.maxBitrateKbps,
    });
    live.sfuSessionId = published.sfuSessionId;
    await pc.setRemoteDescription(published.sessionDescription);
    await this.preferFrameRate(live);
    if (published.qualityCap) await this.applyCap(live, published.qualityCap);
    const kind: SourceKind = surface === 'monitor' ? 'screen' : 'window';
    const reply = await this.request(input.socket, 'stream.announce', {
      sfuSessionId: published.sfuSessionId,
      source: { kind, label: input.labels[surface ?? 'monitor'].slice(0, 128) },
      preset: input.preset,
      hasAudio: audio !== null,
      tracks: [
        { name: 'video', kind: 'video', rids: plan.encodings.map((e) => e.rid) },
        ...(audio ? [{ name: 'audio', kind: 'audio' as const }] : []),
      ],
      layers: live.plan.layers,
    });
    if (reply.type !== 'stream.started') {
      throw reply.type === 'error' ? reply.payload : { code: 'internal_error' };
    }
    const stream = reply.payload.stream;
    live.streamId = stream.streamId;
    this.watch(live);
    this.set({
      phase: 'live',
      streamId: stream.streamId,
      paused: false,
      hasAudio: audio !== null,
      surface,
    });
    this.followCap(live, stream);
  }

  /** Pause (the curtain: nothing leaves) or resume, told to the room as a user pause. */
  async setPaused(paused: boolean): Promise<void> {
    const live = this.live;
    if (!live?.streamId) return;
    await this.setActive(live, !paused);
    const reply = await this.request(live.input.socket, 'stream.update', {
      streamId: live.streamId,
      paused,
      ...(paused ? { pauseReason: 'user' as const } : {}),
    });
    if (reply.type === 'error') throw reply.payload;
    this.set({ paused });
  }

  /** 1080p30 or 1080p60: the capture's frame rate and the encodings follow, then the room. */
  async setPreset(preset: Preset): Promise<void> {
    const live = this.live;
    if (!live?.streamId || preset === this.state.preset) return;
    await live.video
      .applyConstraints({ frameRate: { ideal: presetFrameRate(preset) } })
      .catch(() => undefined);
    const previous = live.input.preset;
    live.input = { ...live.input, preset };
    await this.applyPlan(live);
    const reply = await this.request(live.input.socket, 'stream.update', {
      streamId: live.streamId,
      preset,
      layers: live.plan.layers,
    });
    if (reply.type === 'error') {
      live.input = { ...live.input, preset: previous };
      await this.applyPlan(live);
      throw reply.payload;
    }
    this.set({ preset });
  }

  /** Ends the stream: stream.end on the room socket, then the unpublish. */
  async stop(): Promise<void> {
    const live = this.live;
    if (!live || live.done) return;
    if (live.streamId) {
      await this.request(live.input.socket, 'stream.end', { streamId: live.streamId }).catch(
        () => undefined,
      );
    }
    this.finish(live, { kind: 'stopped' });
  }

  /** The room ended it (stream.stop, stream.ended) or the socket ended for good. */
  private finish(live: Live, end: BrowserEnd): void {
    if (live.done) return;
    this.teardown(live);
    this.set({ ...IDLE, phase: 'ended', roomId: live.input.roomId, ended: end });
  }

  private teardown(current: Live): void {
    current.done = true;
    if (this.live === current) this.live = null;
    for (const cleanup of current.cleanups.splice(0)) cleanup();
    if (current.sfuSessionId) {
      void current.input.api.unpublish(current.sfuSessionId).catch(() => undefined);
    }
    for (const t of current.media.getTracks()) t.stop();
    current.pc.close();
  }

  /** While live: the room's messages, the socket's end, the page going away, stats, thumbnails. */
  private watch(live: Live): void {
    const { socket, api } = live.input;
    live.cleanups.push(live.input.hold());
    live.cleanups.push(
      socket.listen((m) => {
        if (!live.streamId) return;
        if (m.type === 'stream.stop' && m.payload.streamId === live.streamId) {
          this.finish(live, { kind: 'room', reason: m.payload.reason });
        } else if (m.type === 'stream.ended' && m.payload.streamId === live.streamId) {
          this.finish(live, { kind: 'room', reason: m.payload.reason });
        } else if (m.type === 'stream.updated' && m.payload.stream.streamId === live.streamId) {
          this.followCap(live, m.payload.stream);
        } else if (
          m.type === 'welcome' &&
          !m.payload.streams.some((s) => s.streamId === live.streamId)
        ) {
          // Back after a reconnect too late: the room ended it during the grace.
          this.finish(live, { kind: 'room', reason: 'helper_disconnected' });
        }
      }),
    );
    live.cleanups.push(
      socket.onEnded(() => this.finish(live, { kind: 'room', reason: 'helper_disconnected' })),
    );
    const onPageHide = () => {
      if (live.sfuSessionId) api.unpublishOnExit(live.sfuSessionId);
    };
    window.addEventListener('pagehide', onPageHide);
    live.cleanups.push(() => window.removeEventListener('pagehide', onPageHide));
    const stats = setInterval(() => void this.readStats(live), STATS_EVERY_MS);
    live.cleanups.push(() => clearInterval(stats));
    live.cleanups.push(this.thumbnails(live));
  }

  /** Economy mode on the stream (stream.updated carries it): every layer under the cap. */
  private followCap(live: Live, stream: StreamInfo): void {
    const cap = stream.qualityCap ?? null;
    if (JSON.stringify(cap) === JSON.stringify(live.qualityCap)) return;
    void this.applyCap(live, cap);
  }

  private async applyCap(live: Live, cap: QualityCap | null): Promise<void> {
    live.qualityCap = cap;
    await this.applyPlan(live);
  }

  /** Recomputes the encodings (preset, cap, capture size) and gives them to the sender. */
  private async applyPlan(live: Live): Promise<void> {
    live.plan = browserEncodings({
      preset: live.input.preset,
      captured: live.video.getSettings(),
      audio: live.media.getAudioTracks().length > 0,
      roomCapKbps: live.input.settings.maxBitrateKbps,
      qualityCap: live.qualityCap,
    });
    const parameters = live.sender.getParameters();
    parameters.encodings = parameters.encodings.map((e) => {
      const next = live.plan.encodings.find((x) => x.rid === e.rid);
      return next
        ? {
            ...e,
            maxBitrate: next.maxBitrate,
            maxFramerate: next.maxFramerate,
            scaleResolutionDownBy: next.scaleResolutionDownBy,
          }
        : e;
    });
    await live.sender.setParameters(parameters).catch(() => undefined);
  }

  /** Smooth motion over sharpness under load (Chrome's degradationPreference). */
  private async preferFrameRate(live: Live): Promise<void> {
    const parameters = live.sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: string;
    };
    parameters.degradationPreference = 'maintain-framerate';
    await live.sender.setParameters(parameters).catch(() => undefined);
  }

  private async setActive(live: Live, active: boolean): Promise<void> {
    const parameters = live.sender.getParameters();
    parameters.encodings = parameters.encodings.map((e) => ({ ...e, active }));
    await live.sender.setParameters(parameters).catch(() => undefined);
  }

  private lastStats: { at: number; bytes: number } | null = null;

  private async readStats(live: Live): Promise<void> {
    if (live.done) return;
    const report = await live.sender.getStats().catch(() => null);
    if (!report || live.done) return;
    let bytes = 0;
    let top: { width: number; height: number; fps: number; limitation: string | null } | null =
      null;
    report.forEach((s: Record<string, unknown>) => {
      if (s['type'] !== 'outbound-rtp' || s['kind'] !== 'video') return;
      bytes += Number(s['bytesSent'] ?? 0);
      const width = Number(s['frameWidth'] ?? 0);
      if (!top || width > top.width) {
        top = {
          width,
          height: Number(s['frameHeight'] ?? 0),
          fps: Number(s['framesPerSecond'] ?? 0),
          limitation:
            typeof s['qualityLimitationReason'] === 'string' &&
            s['qualityLimitationReason'] !== 'none'
              ? s['qualityLimitationReason']
              : null,
        };
      }
    });
    const now = performance.now();
    const last = this.lastStats;
    this.lastStats = { at: now, bytes };
    const found = top as {
      width: number;
      height: number;
      fps: number;
      limitation: string | null;
    } | null;
    if (!last || !found || now <= last.at) return;
    const sentKbps = Math.max(0, Math.round(((bytes - last.bytes) * 8) / (now - last.at)));
    const targetKbps = live.plan.encodings.reduce((sum, e) => sum + e.maxBitrate / 1000, 0);
    this.set({
      stats: {
        width: found.width,
        height: found.height,
        fps: found.fps,
        sentKbps,
        targetKbps,
        limitation: found.limitation,
      },
    });
  }

  /** A JPEG of the shared screen every 10 s, like the helper's (PROTOCOL 11.3); none while paused. */
  private thumbnails(live: Live): () => void {
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.srcObject = new MediaStream([live.video]);
    void element.play().catch(() => undefined);
    const canvas = document.createElement('canvas');
    const shoot = () => {
      if (live.done || this.state.paused || !live.streamId || element.videoWidth === 0) return;
      const scale = THUMBNAIL_WIDTH / element.videoWidth;
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = Math.max(2, Math.round(element.videoHeight * scale));
      canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (blob && live.streamId && !live.done) {
            void live.input.api.thumbnail(live.streamId, blob).catch(() => undefined);
          }
        },
        'image/jpeg',
        0.7,
      );
    };
    const first = setTimeout(shoot, 1_500);
    const every = setInterval(shoot, THUMBNAIL_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      element.srcObject = null;
    };
  }

  /** Sends a request on the room socket and waits for its reply (by id). */
  private request(socket: PublisherSocket, type: string, payload: object): Promise<Message> {
    return new Promise((resolve, reject) => {
      let stop: () => void = () => undefined;
      const timer = setTimeout(() => {
        stop();
        reject({ code: 'internal_error' } satisfies ErrorPayload);
      }, REPLY_TIMEOUT_MS);
      let id: string | null = null;
      stop = socket.listen((m) => {
        if (id === null || m.id !== id) return;
        clearTimeout(timer);
        stop();
        resolve(m);
      });
      id = socket.sendRequest(type, payload);
      if (id === null) {
        clearTimeout(timer);
        stop();
        reject({ code: 'internal_error' } satisfies ErrorPayload);
      }
    });
  }
}

/** The tab's one browser stream. */
export const browserLive = new BrowserLive();
