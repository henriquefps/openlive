// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodesAv1, noteAv1Failure, preferredCodec, resetAv1Fallback } from '../src/rtc/codec.ts';
import { setup, sfuOffer } from './rtc-fakes.ts';

// AV1 on the viewer: the browser's decoder list decides what to ask for, the
// Worker answers with the AV1 track for a top-layer pull, leaving the top layer pulls H.264, and
// a stalled AV1 pull falls back to H.264.

const settle = () => vi.advanceTimersByTimeAsync(0);
const caps =
  (...mimeTypes: string[]) =>
  () => ({ codecs: mimeTypes.map((mimeType) => ({ mimeType })) });

beforeEach(() => {
  vi.useFakeTimers();
  resetAv1Fallback();
});
afterEach(() => vi.useRealTimers());

const av1Answer = () =>
  Promise.resolve({
    streamId: 'st_1',
    requiresImmediateRenegotiation: true,
    sessionDescription: { type: 'offer' as const, sdp: sfuOffer() },
    tracks: [
      { mid: '1', kind: 'video' as const },
      { mid: '2', kind: 'audio' as const },
    ],
    rid: 'f',
    codec: 'av1' as const,
  });

describe('preferredCodec', () => {
  it('asks for AV1 only when the browser lists an AV1 decoder', () => {
    expect(decodesAv1(caps('video/VP8', 'video/H264', 'video/AV1'))).toBe(true);
    expect(decodesAv1(caps('video/H264'))).toBe(false);
    expect(decodesAv1(() => null)).toBe(false);
    expect(preferredCodec(caps('video/AV1'))).toBe('av1');
    expect(preferredCodec(caps('video/H264'))).toBe('h264');
  });

  it('asks for H.264 for the rest of the tab after an AV1 decoder failure', () => {
    noteAv1Failure();
    expect(preferredCodec(caps('video/AV1'))).toBe('h264');
    expect(sessionStorage.getItem('openlive.av1Fallback')).toBe('1');
  });
});

describe('RtcSource with AV1', () => {
  it('asks for AV1 and keeps the layers on offer', async () => {
    const { api, session, source } = setup();
    api.subscribe.mockImplementationOnce(av1Answer);
    session.start();
    const s = source({}, () => 'av1');
    s.start();
    await settle();
    expect(api.subscribe).toHaveBeenCalledWith(expect.objectContaining({ codec: 'av1' }));
    expect(s.codec).toBe('av1');
    expect(s.layer).toBe('f');
    expect(s.layers.map((l) => l.rid)).toEqual(['f', 'h', 'q']);
  });

  it('leaving the top layer of an AV1 pull pulls H.264 on that layer, staying live, with no PUT .../layer', async () => {
    const { api, session, source } = setup();
    api.subscribe.mockImplementationOnce(av1Answer);
    session.start();
    const s = source({}, () => 'av1');
    s.start();
    await settle();
    // The Worker answers a pull on h with the H.264 track, on h.
    api.subscribe.mockImplementation(async (req) => ({
      ...(await av1Answer()),
      rid: req.rid ?? 'f',
      codec: 'h264',
    }));
    const states: string[] = [];
    s.subscribe(() => states.push(s.state.kind));
    s.setLayer('h');
    await settle();
    expect(api.layer).not.toHaveBeenCalled();
    // H.264 from now on: the AV1 track is the top layer alone.
    expect(api.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ rid: 'h', codec: 'h264' }),
    );
    expect(s.codec).toBe('h264');
    // A switch, not a reconnection: no "the video stopped arriving" screen.
    expect(states).not.toContain('reconnecting');
    // Back to the top layer on the H.264 pull: a plain layer switch.
    s.setLayer('f');
    await settle();
    expect(api.layer).toHaveBeenCalledWith({ sessionId: 's1', streamId: 'st_1', rid: 'f' });
  });

  it('a stalled AV1 pull is pulled again in H.264; a decoder that never produced a frame turns AV1 off for the tab', async () => {
    const { api, session, source } = setup();
    api.subscribe.mockImplementationOnce(av1Answer);
    session.start();
    const s = source({}, () => 'av1');
    s.start();
    await settle();
    s.retry({ framesDecoded: 0 });
    await settle();
    expect(api.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ codec: 'h264' }));
    expect(preferredCodec(caps('video/AV1'))).toBe('h264');
  });

  it('a stall after frames flowed keeps AV1 for other streams', async () => {
    const { api, session, source } = setup();
    api.subscribe.mockImplementationOnce(av1Answer);
    session.start();
    const s = source({}, () => 'av1');
    s.start();
    await settle();
    s.retry({ framesDecoded: 240 });
    await settle();
    expect(api.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ codec: 'h264' }));
    expect(preferredCodec(caps('video/AV1'))).toBe('av1');
  });

  it('the retry button on an H.264 pull changes nothing about the codec', async () => {
    const { api, session, source } = setup();
    session.start();
    const s = source({}, () => 'av1');
    s.start();
    await settle();
    expect(s.codec).toBe('h264');
    s.retry();
    await settle();
    expect(api.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ codec: 'av1' }));
  });
});
