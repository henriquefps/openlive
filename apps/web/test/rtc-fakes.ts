// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo, VideoCodec } from '@openlive/protocol';
import { vi } from 'vitest';
import type { StatsReportLike } from '@openlive/client';
import type { RtcApi } from '../src/rtc/api.ts';
import {
  type LocalTransceiverLike,
  type PeerLike,
  RtcSession,
  type TransceiverLike,
} from '../src/rtc/session.ts';
import { RtcSource } from '../src/rtc/source.ts';

// Fakes for the rtc client: a scripted RtcApi (the Worker's SFU proxy) and a peer connection the
// test drives by hand. jsdom has no WebRTC and no MediaStream.

export const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_1',
  source: { kind: 'window', label: 'Hades II' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 1,
};

/**
 * The SFU's offer after a pull: the data channel, then video (mid 1) and audio (mid 2). `older`
 * pairs are m-sections of earlier pulls, which the SFU keeps offering after tracks/close.
 */
export function sfuOffer(
  video = '1',
  audio = '2',
  older: readonly [string, string][] = [],
): string {
  const pair = (v: string, a: string, n: string) => [
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    `a=mid:${v}`,
    `a=msid:sv${n} tv${n}`,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    `a=mid:${a}`,
    `a=msid:sa${n} ta${n}`,
  ];
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ['a=msid-semantic: WMS', ...older.flatMap((_, i) => [`sv${i}`, `sa${i}`]), 'sv', 'sa'].join(
      ' ',
    ),
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    ...older.flatMap(([v, a], i) => pair(v, a, String(i))),
    ...pair(video, audio, ''),
    '',
  ].join('\r\n');
}

export const fakeTrack = (kind: string, id: string) =>
  Object.assign(new EventTarget(), {
    kind,
    id,
    muted: false,
    readyState: 'live',
  }) as unknown as MediaStreamTrack;

/** A receiving transceiver; stop() ends its track, as RTCRtpTransceiver.stop() does. */
export class FakeTransceiver implements TransceiverLike {
  currentDirection: RTCRtpTransceiverDirection | null = 'recvonly';
  readonly receiver: { track: MediaStreamTrack };
  constructor(
    readonly mid: string,
    kind: string,
  ) {
    this.receiver = { track: fakeTrack(kind, `${kind}-${mid}`) };
  }
  stop() {
    this.currentDirection = 'stopped';
    (this.receiver.track as { readyState: string }).readyState = 'ended';
  }
}

/** A sending transceiver: its mid is set by the next local offer, as in a browser. */
export class FakeLocalTransceiver implements LocalTransceiverLike {
  mid: string | null = null;
  stopped = false;
  sent: (MediaStreamTrack | null)[];
  /** What setParameters was given, in order (simulcast layers turned on and off). */
  parameters: RTCRtpSendParameters[] = [];
  readonly sender = {
    replaceTrack: (track: MediaStreamTrack | null) => {
      this.sent.push(track);
      return Promise.resolve();
    },
    getParameters: (): RTCRtpSendParameters =>
      this.parameters.at(-1) ??
      ({
        encodings: (this.init?.sendEncodings ?? [{}]).map((e) => ({ ...e, active: true })),
      } as unknown as RTCRtpSendParameters),
    setParameters: (parameters: RTCRtpSendParameters) => {
      this.parameters.push(parameters);
      return Promise.resolve();
    },
  };
  constructor(
    track: MediaStreamTrack,
    readonly init?: RTCRtpTransceiverInit,
  ) {
    this.sent = [track];
  }
  stop() {
    this.stopped = true;
  }
}

export class FakePeer implements PeerLike {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channels: string[] = [];
  remote: RTCSessionDescriptionInit[] = [];
  transceivers: FakeTransceiver[] = [];
  local: FakeLocalTransceiver[] = [];
  closed = false;

  constructor(readonly configuration: RTCConfiguration) {}

  createDataChannel(label: string) {
    this.channels.push(label);
    return {};
  }
  createOffer() {
    return Promise.resolve({ type: 'offer' as const, sdp: 'local-offer' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer' as const, sdp: `local-answer-${this.remote.length}` });
  }
  setLocalDescription(description?: RTCSessionDescriptionInit) {
    if (description?.type && description.sdp)
      this.localDescription = { type: description.type, sdp: description.sdp };
    if (description?.type === 'offer') {
      for (const t of this.local) t.mid ??= `l${this.local.indexOf(t)}`;
    }
    return Promise.resolve();
  }
  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote.push(description);
    // Every new m-section of an SFU offer becomes a transceiver with a fresh remote track.
    const sections = (description.sdp ?? '').matchAll(/m=(video|audio)[\s\S]*?a=mid:(\S+)/g);
    for (const [, kind, mid] of sections) {
      if (!kind || !mid || this.transceivers.some((t) => t.mid === mid)) continue;
      this.transceivers.push(new FakeTransceiver(mid, kind));
    }
    return Promise.resolve();
  }
  getTransceivers() {
    return this.transceivers;
  }
  addTransceiver(track: MediaStreamTrack, init?: RTCRtpTransceiverInit) {
    const transceiver = new FakeLocalTransceiver(track, init);
    this.local.push(transceiver);
    return transceiver;
  }
  getStats(): Promise<StatsReportLike> {
    return Promise.resolve(new Map([['IT', { id: 'IT', type: 'inbound-rtp', kind: 'video' }]]));
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  // --- test side ---
  set(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }
}

export class FakeMediaStream extends EventTarget {
  private tracks: MediaStreamTrack[] = [];
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

export const createStream = () => new FakeMediaStream() as unknown as MediaStream;

/** A scripted API: vi.fn per route, so tests can override responses and read the call order. */
export function fakeApi() {
  let sessions = 0;
  return {
    ice: vi.fn<RtcApi['ice']>(() =>
      Promise.resolve({ iceServers: [{ urls: ['stun:stun.example:3478'] }] }),
    ),
    session: vi.fn<RtcApi['session']>(() =>
      Promise.resolve({
        sessionId: `s${++sessions}`,
        iceServers: [],
        sessionDescription: { type: 'answer', sdp: 'sfu-answer' },
      }),
    ),
    subscribe: vi.fn<RtcApi['subscribe']>(() =>
      Promise.resolve({
        streamId: 'st_1',
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: sfuOffer() },
        tracks: [
          { mid: '1', kind: 'video' },
          { mid: '2', kind: 'audio' },
        ],
        rid: 'f',
      }),
    ),
    renegotiate: vi.fn<RtcApi['renegotiate']>(() => Promise.resolve({})),
    layer: vi.fn<RtcApi['layer']>(() => Promise.resolve()),
    unsubscribe: vi.fn<RtcApi['unsubscribe']>(() => Promise.resolve()),
    leave: vi.fn<RtcApi['leave']>(),
  } satisfies RtcApi;
}

export function setup() {
  const api = fakeApi();
  const peers: FakePeer[] = [];
  const session = new RtcSession({
    api,
    createPeer: (configuration) => {
      const peer = new FakePeer(configuration);
      peers.push(peer);
      return peer;
    },
    disconnectGraceMs: 5_000,
  });
  const source = (patch: Partial<StreamInfo> = {}, preferredCodec?: () => VideoCodec) =>
    new RtcSource(session, {
      stream: { ...STREAM, ...patch },
      slotId: 'sl_1',
      createStream,
      ...(preferredCodec ? { preferredCodec } : {}),
    });
  return { api, peers, session, source, peer: () => peers.at(-1) as FakePeer };
}
