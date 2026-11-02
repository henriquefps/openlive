// SPDX-License-Identifier: AGPL-3.0-only
import type { WelcomePayload } from '@openlive/protocol';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import { MediaFactoryContext, type MediaRequest, useWatchMedia } from '../src/player/media.ts';
import Player from '../src/player/Player.tsx';
import { markWatchStart } from '../src/player/ttff.ts';
import { RoomConnection, type SocketLike } from '../src/room/connection.ts';
import { rtcMediaFactory } from '../src/rtc/media.ts';
import { FakeMediaStream, setup, STREAM } from './rtc-fakes.ts';

// The rtc media factory plugged into the player (useWatchMedia → RtcSource → Player), and into the
// room socket's slot: the pull uses the granted slot, the lease is renewed while watching, and
// closing the view unsubscribes and releases the slot.

const GRANTED = { kind: 'granted', slotId: 'sl_1', expiresAt: 30_000, leaseMs: 30_000 } as const;

function Watch({ request }: { request: MediaRequest | null }) {
  const media = useWatchMedia(request);
  return (
    <Player
      stream={media?.stream ?? null}
      source={media?.source ?? null}
      room={{ status: 'open', ended: null }}
      streamInfo={STREAM}
      endedReason={null}
      access={GRANTED}
      streamer={{ userId: 'u_ana', name: 'Ana' }}
      hasAudio
      viewers={{ used: 1, limit: 6, queueLength: 0 }}
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
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the rtc media factory in the player', () => {
  it('connecting → live on the first frame, with the TTFF measured; unmount unsubscribes', async () => {
    const { api, session } = setup();
    session.start();
    markWatchStart(STREAM.streamId, performance.now() - 250);
    const request: MediaRequest = {
      roomId: 'rm_1',
      stream: STREAM,
      slotId: 'sl_1',
    };
    const view = render(
      <MediaFactoryContext value={rtcMediaFactory(session)}>
        <Watch request={request} />
      </MediaFactoryContext>,
    );
    const player = () => view.container.querySelector('[data-screen]');
    expect(player()?.getAttribute('data-screen')).toBe('connecting');
    await waitFor(() => expect(api.renegotiate).toHaveBeenCalled());
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_1',
      streamId: 'st_1',
      codec: 'h264',
    });
    // Live, but no frame yet: still "connecting".
    expect(player()?.getAttribute('data-screen')).toBe('connecting');
    const video = view.container.querySelector('video');
    if (video) act(() => void fireEvent(video, new Event('playing')));
    await waitFor(() => expect(player()?.getAttribute('data-screen')).toBe('live'));
    expect(Number(player()?.getAttribute('data-ttff-ms'))).toBeGreaterThanOrEqual(250);
    view.unmount();
    await waitFor(() => expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1'));
  });
});

/** A room socket the test drives by hand. */
class Socket implements SocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: { type: string; id?: string; payload: Record<string, unknown> }[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as (typeof this.sent)[number]);
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
}

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
  streams: [STREAM],
};

describe('the rtc source on the room socket slot', () => {
  it('pulls with the granted slot, renews the lease while watching, then unsubscribes and releases', async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const connection = new RoomConnection({
      url: 'ws://localhost/ws/rooms/rm_1',
      tabId: 't_tab',
      createSocket: () => socket,
    });
    connection.start();
    socket.open();
    socket.receive('welcome', WELCOME);
    const { api, session } = setup();
    session.start();

    connection.watch('st_1');
    const request = socket.sent.find((m) => m.type === 'slot.request');
    socket.receive(
      'slot.granted',
      { slotId: 'sl_7', streamId: 'st_1', expiresAt: 30_000, leaseMs: 30_000 },
      request?.id,
    );
    const access = connection.getState().access['st_1'];
    expect(access?.kind).toBe('granted');
    if (access?.kind !== 'granted') return;
    const media = await rtcMediaFactory(session)({
      roomId: 'rm_1',
      stream: STREAM,
      slotId: access.slotId,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.subscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      slotId: 'sl_7',
      streamId: 'st_1',
      codec: 'h264',
    });
    expect(media.source.state).toEqual({ kind: 'live' });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.filter((m) => m.type === 'slot.renew')).toEqual([
      { type: 'slot.renew', payload: { slotId: 'sl_7' } },
      { type: 'slot.renew', payload: { slotId: 'sl_7' } },
    ]);

    // Closing the watch view: the media stops, the slot goes back.
    media.stop();
    connection.unwatch('st_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.unsubscribe).toHaveBeenCalledWith('s1', 'st_1');
    expect(socket.sent.at(-1)).toEqual({ type: 'slot.release', payload: { slotId: 'sl_7' } });
    connection.stop();
  });
});
