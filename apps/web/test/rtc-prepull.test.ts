// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchAccess } from '../src/room/connection.ts';
import { rtcMediaFactory } from '../src/rtc/media.ts';
import { deferUnwatch, PREPULL_LAYER, PrePuller } from '../src/rtc/prepull.ts';
import { RtcSource } from '../src/rtc/source.ts';
import { createStream, FakeMediaStream, setup, STREAM } from './rtc-fakes.ts';

// Pull on hover (rtc/prepull.ts): the policy (dwell, hold, cap, full streams, one at a
// time), the slot it takes and gives back, and the click that takes the pre-pulled source over,
// or falls back to a normal pull.

const settle = () => vi.advanceTimersByTimeAsync(0);
const granted = (slotId = 'sl_1'): WatchAccess => ({
  kind: 'granted',
  slotId,
  expiresAt: Date.now() + 30_000,
  leaseMs: 30_000,
});

function harness(options: { holdMs?: number; maxMs?: number } = {}) {
  const rtc = setup();
  const actions = { watch: vi.fn<(id: string) => void>(), unwatch: vi.fn<(id: string) => void>() };
  const warm = vi.fn(() => vi.fn());
  const prepuller = new PrePuller(rtc.session, actions, {
    dwellMs: 150,
    holdMs: options.holdMs ?? 5_000,
    maxMs: options.maxMs ?? 20_000,
    warm,
    createSource: (session, stream, slotId) => {
      const source = new RtcSource(session, { stream, slotId, createStream });
      source.layer = PREPULL_LAYER;
      return source;
    },
  });
  return { ...rtc, actions, warm, prepuller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('MediaStream', FakeMediaStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PrePuller', () => {
  it('takes a slot after the dwell and pulls the q layer on the connected session', async () => {
    const { api, session, actions, warm, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(149);
    expect(actions.watch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actions.watch).toHaveBeenCalledWith('st_1');
    expect(prepuller.phase).toBe('requesting');
    prepuller.sync({ st_1: granted() });
    await settle();
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_1',
      streamId: 'st_1',
      codec: 'h264',
      rid: 'q',
    });
    expect(prepuller.phase).toBe('pulled');
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('a pointer passing over a card requests nothing', async () => {
    const { actions, prepuller } = harness();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(100);
    prepuller.leave('st_1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actions.watch).not.toHaveBeenCalled();
    expect(actions.unwatch).not.toHaveBeenCalled();
  });

  it('releases the pull and the slot some seconds after the pointer leaves', async () => {
    const { api, session, actions, prepuller } = harness({ holdMs: 5_000 });
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await settle();
    prepuller.leave('st_1');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(actions.unwatch).not.toHaveBeenCalled();
    // Back on the card in time: kept.
    prepuller.hover(STREAM, granted());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actions.unwatch).not.toHaveBeenCalled();
    prepuller.leave('st_1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
    expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
    expect(prepuller.streamId).toBeNull();
  });

  it('releases after maxMs even while the pointer stays', async () => {
    const { actions, session, prepuller } = harness({ maxMs: 20_000 });
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(actions.unwatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
  });

  it('never queues: a full stream is given up at once', async () => {
    const { api, actions, prepuller } = harness();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: { kind: 'full', queue: null } });
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it('leaves alone a stream already watched, queued for, or paused', async () => {
    const { actions, prepuller } = harness();
    prepuller.hover(STREAM, granted());
    prepuller.hover({ ...STREAM, streamId: 'st_2' }, { kind: 'full', queue: null });
    prepuller.hover({ ...STREAM, streamId: 'st_3', paused: true }, undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(actions.watch).not.toHaveBeenCalled();
  });

  it('one pre-pull at a time: a new hover releases the previous one', async () => {
    const { session, actions, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await settle();
    prepuller.hover({ ...STREAM, streamId: 'st_2' }, undefined);
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
    await vi.advanceTimersByTimeAsync(150);
    expect(actions.watch).toHaveBeenLastCalledWith('st_2');
  });

  it('dispose() gives everything back', async () => {
    const { session, actions, api, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await settle();
    prepuller.dispose();
    await settle();
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
    expect(api.unsubscribe).toHaveBeenCalled();
  });
});

describe('the click on a pre-pulled stream', () => {
  it('hands the live source to the watch view and switches up with tracks/update', async () => {
    const { api, session, actions, prepuller } = harness();
    api.subscribe.mockResolvedValueOnce({
      streamId: 'st_1',
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ mid: '1', kind: 'video' }],
      rid: 'q',
    });
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await settle();
    // The click: the watch view owns the slot from now on; the hold timer cannot release it.
    prepuller.claim('st_1');
    prepuller.leave('st_1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions.unwatch).not.toHaveBeenCalled();

    const media = await rtcMediaFactory(
      session,
      prepuller,
    )({
      roomId: 'rm_1',
      stream: STREAM,
      slotId: 'sl_1',
    });
    expect(media.start).toBe('prepull');
    expect(media.source.state).toEqual({ kind: 'live' });
    await settle();
    // No second pull, no renegotiation: one PUT .../layer to the top layer.
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    expect(api.renegotiate).toHaveBeenCalledTimes(1);
    expect(api.layer).toHaveBeenCalledWith({ sessionId: 's1', streamId: 'st_1', rid: 'f' });
    expect(media.source.layer).toBe('f');
    media.stop();
    await settle();
    expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
  });

  it('a click before the slot came falls back to a normal pull', async () => {
    const { api, session, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.claim('st_1');
    // The watch view's own pull once the slot is granted.
    prepuller.sync({ st_1: granted() });
    const media = await rtcMediaFactory(
      session,
      prepuller,
    )({
      roomId: 'rm_1',
      stream: STREAM,
      slotId: 'sl_1',
    });
    await settle();
    expect(media.start).toBe('click');
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_1',
      streamId: 'st_1',
      codec: 'h264',
    });
  });

  it('a pre-pull on another slot is not reused', async () => {
    const { api, session, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted('sl_old') });
    await settle();
    prepuller.claim('st_1');
    const media = await rtcMediaFactory(
      session,
      prepuller,
    )({
      roomId: 'rm_1',
      stream: STREAM,
      slotId: 'sl_new',
    });
    await settle();
    expect(media.start).toBe('click');
    expect(api.subscribe).toHaveBeenLastCalledWith({
      sessionId: 's1',
      slotId: 'sl_new',
      streamId: 'st_1',
      codec: 'h264',
    });
  });

  it('without a pre-puller the factory pulls on the click as before', async () => {
    const { api, session } = harness();
    session.start();
    await settle();
    const media = await rtcMediaFactory(session)({
      roomId: 'rm_1',
      stream: STREAM,
      slotId: 'sl_1',
    });
    await settle();
    expect(media.start).toBe('click');
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_1',
      streamId: 'st_1',
      codec: 'h264',
    });
  });
});

describe('remounts (React StrictMode replays effects in development)', () => {
  it('a watch view mounted twice shares the pre-pulled source and stops it once', async () => {
    const { api, session, prepuller } = harness();
    session.start();
    await settle();
    prepuller.hover(STREAM, undefined);
    await vi.advanceTimersByTimeAsync(150);
    prepuller.sync({ st_1: granted() });
    await settle();
    prepuller.claim('st_1');
    const factory = rtcMediaFactory(session, prepuller);
    const request = { roomId: 'rm_1', stream: STREAM, slotId: 'sl_1' };
    const first = await factory(request);
    const second = await factory(request);
    expect(second.source).toBe(first.source);
    expect(second.start).toBe('prepull');
    first.stop();
    await settle();
    expect(api.unsubscribe).not.toHaveBeenCalled();
    second.stop();
    await settle();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(1);
  });

  it('deferUnwatch keeps a slot that is watched again in the same task', async () => {
    const actions = {
      watch: vi.fn<(id: string) => void>(),
      unwatch: vi.fn<(id: string) => void>(),
    };
    const deferred = deferUnwatch(actions);
    deferred.unwatch('st_1');
    deferred.watch('st_1');
    await settle();
    expect(actions.unwatch).not.toHaveBeenCalled();
    expect(actions.watch).not.toHaveBeenCalled();
    deferred.unwatch('st_1');
    await settle();
    expect(actions.unwatch).toHaveBeenCalledWith('st_1');
    deferred.watch('st_2');
    expect(actions.watch).toHaveBeenCalledWith('st_2');
  });
});
