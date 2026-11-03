// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaybackLoop } from '../src/player/hooks.ts';
import type { StatsReportLike } from '@openlive/client';
import { resetAv1Fallback } from '../src/rtc/codec.ts';
import { streamLayers } from '../src/rtc/source.ts';
import { FakeMediaStream, setup, sfuOffer } from './rtc-fakes.ts';

// Automatic on an AV1 stream whose viewer cannot keep up with the top layer in AV1 (production,
// 2026-10-28: a native 3440x1440 stream, a Mac viewer, "the video stopped arriving" every ~7 s).
// The AV1 track is the top layer alone, so leaving it is a new pull on the H.264 track. That pull
// must happen once: the source stays live through it (no reconnecting screen, Automatic keeps its
// state), stays on H.264 afterwards, and the policy's later steps are PUT .../layer on that track.

const NATIVE_ULTRAWIDE = [
  { rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 25000 },
  { rid: 'h', width: 1728, height: 720, fps: 60, kbps: 3500 },
  { rid: 'q', width: 1152, height: 480, fps: 30, kbps: 1000 },
];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  vi.stubGlobal('MediaStream', FakeMediaStream);
  resetAv1Fallback();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('streamLayers', () => {
  it('uses the layers the helper encodes, and the preset table without them', () => {
    expect(streamLayers({ preset: 'native', layers: NATIVE_ULTRAWIDE })).toEqual([
      { rid: 'f', width: 3440, height: 1440, fps: 60, kbps: 25000 },
      { rid: 'h', width: 1728, height: 720, fps: 60, kbps: 3500 },
      { rid: 'q', width: 1152, height: 480, fps: 30, kbps: 1000 },
    ]);
    // A helper before 1.19: the preset's nominal 2160p60.
    expect(streamLayers({ preset: 'native' }).map((l) => [l.rid, l.height, l.fps])).toEqual([
      ['f', 2160, 60],
      ['h', 720, 60],
      ['q', 480, 30],
    ]);
  });
});

describe('Automatic on an AV1 pull the viewer cannot keep up with', () => {
  it('falls back to H.264 once and never pulls again', async () => {
    const { api, session, source } = setup();
    // The Worker: the AV1 track for a top-layer pull that asks for it, H.264 otherwise.
    api.subscribe.mockImplementation((req) =>
      Promise.resolve({
        streamId: 'st_1',
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer' as const, sdp: sfuOffer() },
        tracks: [
          { mid: '1', kind: 'video' as const },
          { mid: '2', kind: 'audio' as const },
        ],
        rid: req.rid ?? 'f',
        codec:
          (req.rid ?? 'f') === 'f' && req.codec === 'av1' ? ('av1' as const) : ('h264' as const),
      }),
    );
    session.start();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const s = source({ preset: 'native', layers: NATIVE_ULTRAWIDE }, () => 'av1');
    s.start();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(s.codec).toBe('av1');
    expect(s.layers.map((l) => l.height)).toEqual([1440, 720, 480]);

    // 60 fps on every layer; the AV1 decoder takes 20 ms a frame (over the 13 ms budget), H.264
    // 4 ms. Each pull starts a new RTP stream with its own counters.
    let pulls = 0;
    let frames = 0;
    let decodeS = 0;
    let codec = s.codec;
    s.getStats = (): Promise<StatsReportLike> => {
      if (api.subscribe.mock.calls.length !== pulls || s.codec !== codec) {
        pulls = api.subscribe.mock.calls.length;
        codec = s.codec;
        frames = 0;
        decodeS = 0;
      }
      frames += 60;
      decodeS += 60 * (codec === 'av1' ? 0.02 : 0.004);
      const at = Date.now();
      return Promise.resolve(
        new Map<string, Record<string, unknown> & { type: string; id: string }>([
          [
            'IT',
            {
              id: 'IT',
              type: 'inbound-rtp',
              kind: 'video',
              codecId: 'C',
              framesDecoded: frames,
              framesReceived: frames,
              totalDecodeTime: decodeS,
              packetsReceived: frames * 10,
              packetsLost: 0,
              bytesReceived: frames * 10_000,
              lastPacketReceivedTimestamp: at,
              timestamp: at,
            },
          ],
          ['C', { id: 'C', type: 'codec', mimeType: codec === 'av1' ? 'video/AV1' : 'video/H264' }],
        ]),
      );
    };

    const states: string[] = [];
    s.subscribe(() => states.push(s.state.kind));
    renderHook(() => usePlaybackLoop({ source: s, quality: 'auto', active: true }));
    for (let second = 0; second < 120; second++) {
      await act(() => vi.advanceTimersByTimeAsync(1_000));
    }

    // The join and one pull off the AV1 track, on the middle layer, in H.264.
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(api.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ rid: 'h', codec: 'h264' }),
    );
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    // The viewer never saw "the video stopped arriving".
    expect(states).not.toContain('reconnecting');
    // Back up on the H.264 top layer, which this viewer decodes in time: one PUT, and it holds.
    expect(api.layer.mock.calls.map(([req]) => req.rid)).toEqual(['f']);
    expect(s.codec).toBe('h264');
    expect(s.layer).toBe('f');

    // A later pull (the watchdog's, a resume) stays on H.264.
    s.retry();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ rid: 'f', codec: 'h264' }),
    );
  });
});
