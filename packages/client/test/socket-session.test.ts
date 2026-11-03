// SPDX-License-Identifier: AGPL-3.0-only
import {
  CloseCode,
  PING_FRAME as PROTOCOL_PING_FRAME,
  PROTOCOL_VERSION,
  type WelcomePayload,
} from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  CLOSE,
  HubConnection,
  PING_FRAME,
  PROTOCOL,
  retryDelay,
  RoomConnection,
  SocketDialError,
  type SocketUrl,
  SpacePresenceConnection,
  WELCOME_TIMEOUT_MS,
} from '../src/index.ts';
import { FakeSocket } from './fake-socket.ts';

const welcome: WelcomePayload = {
  protocol: { major: 1, minor: 0 },
  minProtocol: { major: 1, minor: 0 },
  serverTime: 0,
  you: {
    userId: 'u_ana',
    connectionId: 'c_1',
    role: 'owner',
    permissions: { canStream: true, canModerate: true },
  },
  room: { roomId: 'rm_1', spaceId: 'sp_1', kind: 'fixed', visibility: 'space', name: 'Room' },
  settings: { maxStreams: 4, maxViewersPerStream: 6, maxBitrateKbps: 8000, allowedPresets: [] },
  members: [],
  streams: [],
};

let sockets: FakeSocket[];
const last = () => {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket');
  return socket;
};
const createSocket = (url: string) => {
  const socket = new FakeSocket(url);
  sockets.push(socket);
  return socket;
};
const common = { tabId: 't_1', clientVersion: '9.9.9', createSocket, random: () => 0 };

/** A SocketUrl like the app's: a fresh ticket per call, after an await. */
function tickets() {
  let n = 0;
  const url = vi.fn(async () => `wss://openlive.example/ws/rooms/rm_1?ticket=olt_${++n}`);
  return url;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('shared constants', () => {
  it('match @openlive/protocol', () => {
    expect(PING_FRAME).toBe(PROTOCOL_PING_FRAME);
    expect(PROTOCOL).toEqual(PROTOCOL_VERSION);
    expect(CLOSE).toEqual({
      Unauthenticated: CloseCode.Unauthenticated,
      Replaced: CloseCode.Replaced,
      Forbidden: CloseCode.Forbidden,
      Kicked: CloseCode.Kicked,
      RoomClosed: CloseCode.RoomClosed,
      ProtocolUnsupported: CloseCode.ProtocolUnsupported,
    });
  });

  it('back off exponentially with jitter, up to the cap', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 0.999_999)).toBe(500);
    expect(backoffDelay(20, () => 0.999_999)).toBe(BACKOFF_MAX_MS);
    expect(retryDelay(1006, 3, () => 0)).toBe(2000);
  });
});

describe('a socket URL fetched before each connect (the app ticket)', () => {
  it('says hello with the client version and tab id once the ticket URL is in', async () => {
    const url = tickets();
    const room = new RoomConnection({ ...common, url });
    room.start();
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().url).toBe('wss://openlive.example/ws/rooms/rm_1?ticket=olt_1');
    last().open();
    expect(last().hello).toMatchObject({
      type: 'hello',
      payload: { protocol: PROTOCOL, client: 'web', clientVersion: '9.9.9', tabId: 't_1' },
    });
    last().receive('welcome', welcome);
    expect(room.getState().status).toBe('open');
    room.stop();
  });

  it('fetches a new ticket for every reconnect', async () => {
    const url = tickets();
    const room = new RoomConnection({ ...common, url });
    room.start();
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    last().receive('welcome', welcome);
    last().serverClose(1006);
    expect(room.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(backoffDelay(0, () => 0));
    expect(url).toHaveBeenCalledTimes(2);
    expect(last().url).toMatch(/ticket=olt_2$/);
    expect(sockets).toHaveLength(2);
    room.stop();
  });

  it('a failed ticket is a 1006 close: reconnect with backoff', async () => {
    let fail = true;
    const url = vi.fn(async () => {
      if (fail) throw new TypeError('offline');
      return 'wss://openlive.example/ws/hub?ticket=olt_x';
    });
    const hub = new HubConnection({ ...common, url });
    hub.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    expect(hub.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    fail = false;
    await vi.advanceTimersByTimeAsync(backoffDelay(0, () => 0));
    expect(sockets).toHaveLength(1);
    last().open();
    last().receive('hub.welcome', { helpers: [] });
    expect(hub.getState()).toMatchObject({ status: 'open', attempt: 0 });
    hub.stop();
  });

  it('a ticket refused with 401 ends the socket as unauthenticated, without retrying', async () => {
    const url: SocketUrl = async () => {
      throw new SocketDialError(CLOSE.Unauthenticated);
    };
    const room = new RoomConnection({ ...common, url });
    room.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.getState()).toMatchObject({ status: 'ended', ended: { kind: 'unauthenticated' } });
    expect(sockets).toHaveLength(0);
  });

  it('a URL that arrives after stop() opens nothing', async () => {
    let resolve: (url: string) => void = () => undefined;
    const url = () =>
      new Promise<string>((r) => {
        resolve = r;
      });
    const space = new SpacePresenceConnection({ ...common, url });
    space.start();
    space.stop();
    resolve('wss://openlive.example/ws/spaces/sp_1?ticket=olt_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
  });

  it('start() and reconnect() while the ticket is on its way do not dial twice', async () => {
    const url = tickets();
    const space = new SpacePresenceConnection({ ...common, url });
    space.start();
    space.start();
    space.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(url).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    space.stop();
  });

  it('no welcome in time: the socket is dropped and dialled again', async () => {
    const url = tickets();
    const hub = new HubConnection({ ...common, url });
    hub.start();
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    await vi.advanceTimersByTimeAsync(WELCOME_TIMEOUT_MS);
    expect(hub.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(backoffDelay(0, () => 0));
    expect(sockets).toHaveLength(2);
    expect(url).toHaveBeenCalledTimes(2);
    hub.stop();
  });
});

describe('a plain URL (the web)', () => {
  it('creates the socket synchronously, as before', () => {
    const room = new RoomConnection({ ...common, url: 'ws://localhost/ws/rooms/rm_1' });
    room.start();
    expect(last().url).toBe('ws://localhost/ws/rooms/rm_1');
    room.stop();
    expect(last().closedWith).toBe(1000);
  });
});
