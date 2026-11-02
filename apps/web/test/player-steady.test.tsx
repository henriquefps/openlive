// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo, WelcomePayload } from '@openlive/protocol';
import { act, render } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import { MediaFactoryContext, useWatchMedia } from '../src/player/media.ts';
import Player from '../src/player/Player.tsx';
import { RoomConnection, type SocketLike } from '../src/room/connection.ts';
import { rtcMediaFactory } from '../src/rtc/media.ts';
import { FakeMediaStream, setup, STREAM } from './rtc-fakes.ts';

// A minute of watching a 120 fps stream while the room does what it does all the time: a
// thumbnail's stream.updated every 10 s, viewers broadcasts, slot renewals every 30 s and the
// socket's pings. None of it may touch the pull: every pull again or layer switch makes the SFU ask
// the helper for a keyframe, and that IDR reaches every viewer of the layer (the "everyone stutters
// every 30 s" report). The session-wide stats also list a stopped receiver frozen at more frames
// than the live one, as a browser may keep it: the player must not take it for its own, see a
// stall and pull again.

/** A room socket the test drives by hand. */
class Socket implements SocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: (string | { type: string; id?: string; payload: Record<string, unknown> })[] = [];
  send(data: string) {
    this.sent.push(data.startsWith('{"type":"ping"') ? 'ping' : JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(type: string, payload: object, id?: string) {
    const frame = id === undefined ? { type, payload } : { type, id, payload };
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
  messages(type: string) {
    return this.sent.filter((m) => typeof m !== 'string' && m.type === type) as {
      type: string;
      id?: string;
      payload: Record<string, unknown>;
    }[];
  }
}

const GAME120: StreamInfo = { ...STREAM, preset: 'game120' };

const WELCOME: WelcomePayload = {
  protocol: { major: 1, minor: 1 },
  minProtocol: { major: 1, minor: 0 },
  serverTime: Date.now(),
  you: {
    userId: 'u_bia',
    connectionId: 'c_1',
    role: 'member',
    permissions: { canStream: false, canModerate: false },
  },
  room: { roomId: 'rm_1', spaceId: 'sp_1', kind: 'fixed', visibility: 'space', name: 'Game night' },
  settings: { maxStreams: 4, maxViewersPerStream: 6, maxBitrateKbps: 8000, allowedPresets: [] },
  members: [],
  streams: [GAME120],
};

/** The watch view as the room page wires it: everything from the room socket's state. */
function Room({ connection }: { connection: RoomConnection }) {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const stream = state.streams.find((s) => s.streamId === 'st_1') ?? null;
  const access = state.access['st_1'];
  const media = useWatchMedia(
    stream && access?.kind === 'granted' ? { roomId: 'rm_1', stream, slotId: access.slotId } : null,
  );
  const viewers = state.viewers['st_1'];
  return (
    <Player
      stream={media?.stream ?? null}
      source={media?.source ?? null}
      room={{ status: state.status, ended: state.ended }}
      streamInfo={stream}
      endedReason={null}
      access={access ?? null}
      streamer={{ userId: 'u_ana', name: 'Ana' }}
      hasAudio
      viewers={{ used: viewers?.used ?? 1, limit: 6, queueLength: 0 }}
      theater={false}
      onTheaterChange={() => undefined}
      onJoinQueue={() => undefined}
      onLeaveQueue={() => undefined}
      onAccept={() => undefined}
      onRetry={() => undefined}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a minute of steady watching', () => {
  it('pulls once and never again: no pull, layer switch or renegotiation after the join', async () => {
    const socket = new Socket();
    const connection = new RoomConnection({
      url: 'ws://localhost/ws/rooms/rm_1',
      tabId: 't_tab',
      createSocket: () => socket,
    });
    connection.start();
    socket.open();
    socket.receive('welcome', WELCOME);
    const { api, session, peer } = setup();
    session.start();
    await act(() => vi.advanceTimersByTimeAsync(0));

    const view = render(
      <MediaFactoryContext value={rtcMediaFactory(session)}>
        <Room connection={connection} />
      </MediaFactoryContext>,
    );
    act(() => connection.watch('st_1'));
    const request = socket.messages('slot.request')[0];
    act(() =>
      socket.receive(
        'slot.granted',
        { slotId: 'sl_1', streamId: 'st_1', expiresAt: Date.now() + 90_000, leaseMs: 90_000 },
        request?.id,
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    expect(api.renegotiate).toHaveBeenCalledTimes(1);

    // The live pull decodes 120 fps; a stopped receiver's report stays frozen at 50 000 frames.
    const start = Date.now();
    const live = () => ({
      id: 'IT-live',
      type: 'inbound-rtp',
      kind: 'video',
      framesDecoded: Math.floor(((Date.now() - start) / 1000) * 120),
      packetsReceived: Math.floor(((Date.now() - start) / 1000) * 800),
      lastPacketReceivedTimestamp: Date.now(),
    });
    const stale = {
      id: 'IT-stopped',
      type: 'inbound-rtp',
      kind: 'video',
      framesDecoded: 50_000,
      packetsReceived: 300_000,
      lastPacketReceivedTimestamp: start - 60_000,
    };
    const video = peer().transceivers.find((t) => t.receiver.track.kind === 'video');
    const audio = peer().transceivers.find((t) => t.receiver.track.kind === 'audio');
    if (!video || !audio) throw new Error('no pulled transceivers');
    Object.assign(video.receiver, {
      getStats: () => Promise.resolve(new Map([['IT-live', live()]])),
    });
    Object.assign(audio.receiver, { getStats: () => Promise.resolve(new Map()) });
    peer().getStats = () =>
      Promise.resolve(
        new Map<string, Record<string, unknown> & { type: string; id: string }>([
          ['IT-stopped', stale],
          ['IT-live', live()],
        ]),
      );

    let renewed = 0;
    for (let second = 1; second <= 60; second++) {
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      if (second % 10 === 0) {
        // A new thumbnail (and a viewer count) every 10 s: a new StreamInfo object each time.
        act(() =>
          socket.receive('stream.updated', {
            stream: { ...GAME120, thumbnailAt: Date.now(), viewerCount: 1 + (second % 3) },
          }),
        );
        act(() =>
          socket.receive('viewers', {
            streamId: 'st_1',
            viewerUserIds: ['u_bia'],
            used: 1 + (second % 3),
            limit: 6,
            queueLength: 0,
          }),
        );
      }
      for (const renew of socket.messages('slot.renew').slice(renewed)) {
        act(() =>
          socket.receive('slot.renewed', {
            slotId: renew.payload['slotId'],
            expiresAt: Date.now() + 90_000,
          }),
        );
        renewed += 1;
      }
    }

    // The room did its periodic work…
    expect(socket.messages('slot.renew')).toHaveLength(2);
    expect(socket.sent.filter((m) => m === 'ping')).toHaveLength(2);
    // …and the pull was left alone: the join's subscribe and nothing after it.
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    expect(api.renegotiate).toHaveBeenCalledTimes(1);
    expect(api.layer).not.toHaveBeenCalled();
    expect(api.unsubscribe).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-screen]')?.getAttribute('data-screen')).not.toBe(
      'reconnecting',
    );

    view.unmount();
    connection.stop();
  });
});
