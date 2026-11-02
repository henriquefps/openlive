// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import type { MsidLink, Publication } from '../src/rtc/session.ts';
import { CameraClient, type CameraMedia, DEFAULT_CAMERA_PREFS } from '../src/voice/camera.ts';
import type { DevicesLike } from '../src/voice/client.ts';
import type { CameraTrack } from '../src/voice/contract.ts';
import { FakeSignal } from './voice-fakes.ts';

// Fakes for the camera client (voice/camera.ts): the SFU session's camera side and the cameras.
// jsdom has no getUserMedia or WebRTC.

export class FakeCameraTrack extends EventTarget {
  readonly kind = 'video';
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
const asTrack = (t: FakeCameraTrack) => t as unknown as MediaStreamTrack;

export const camera = (userId: string, rids = ['h', 'l']): CameraTrack => ({
  trackId: `ct_${userId}`,
  userId,
  rids,
});

export function fakeCameraMedia() {
  const resetListeners = new Set<() => void>();
  const publications: (Publication & { layers: ((rid: string) => boolean)[] })[] = [];
  let refusal: ApiError | null = null;
  const media = {
    publish: vi.fn<CameraMedia['publish']>(() => {
      if (refusal) return Promise.reject(refusal);
      const layers: ((rid: string) => boolean)[] = [];
      const publication = {
        sessionId: 's1',
        mid: String(publications.length),
        layers,
        replaceTrack: vi.fn(() => Promise.resolve()),
        setActiveLayers: (active: (rid: string) => boolean) => {
          layers.push(active);
          return Promise.resolve();
        },
      };
      publications.push(publication);
      return Promise.resolve(publication);
    }),
    unpublish: vi.fn<CameraMedia['unpublish']>(() => Promise.resolve()),
    drop: vi.fn<CameraMedia['drop']>(() => Promise.resolve()),
    pull: vi.fn<CameraMedia['pull']>((cameras) =>
      Promise.resolve(
        new Map(
          cameras.map((c) => [c.trackId, asTrack(new FakeCameraTrack(`remote-${c.userId}`))]),
        ),
      ),
    ),
    unpull: vi.fn<CameraMedia['unpull']>(() => Promise.resolve()),
    setLayer: vi.fn<CameraMedia['setLayer']>(() => Promise.resolve()),
    link: vi.fn<(links: readonly MsidLink[]) => void>(),
    onReset: (listener: () => void) => {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
  } satisfies CameraMedia;
  return {
    media,
    publications,
    refuse: (code: string, extra: Record<string, unknown> = {}) => {
      refusal = new ApiError(409, { code, ...extra });
    },
    reset: () => {
      for (const listener of resetListeners) listener();
    },
  };
}

export function fakeCameraDevices() {
  const cams: FakeCameraTrack[] = [];
  let failure: string | null = null;
  const devices = {
    getUserMedia: vi.fn<DevicesLike['getUserMedia']>(() => {
      if (failure !== null) return Promise.reject(new DOMException('no', failure));
      const track = new FakeCameraTrack(`cam-${cams.length + 1}`);
      cams.push(track);
      return Promise.resolve({
        getVideoTracks: () => [asTrack(track)],
        getTracks: () => [asTrack(track)],
      } as unknown as MediaStream);
    }),
    enumerateDevices: vi.fn<DevicesLike['enumerateDevices']>(() =>
      Promise.resolve([
        { deviceId: 'cam-a', kind: 'videoinput', label: 'Webcam', groupId: '' },
        { deviceId: 'mic-a', kind: 'audioinput', label: 'Headset', groupId: '' },
      ] as unknown as MediaDeviceInfo[]),
    ),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } satisfies DevicesLike;
  return {
    devices,
    cams,
    fail: (name: string | null) => {
      failure = name;
    },
  };
}

export function setupCamera(signal = new FakeSignal()) {
  const media = fakeCameraMedia();
  const devices = fakeCameraDevices();
  const saved: unknown[] = [];
  const client = new CameraClient({
    signal,
    media: media.media,
    devices: devices.devices,
    prefs: DEFAULT_CAMERA_PREFS,
    savePrefs: (p) => saved.push(p),
  });
  client.start();
  return { client, signal, media, devices, saved, cam: () => devices.cams.at(-1) };
}
