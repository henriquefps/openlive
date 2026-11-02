// SPDX-License-Identifier: AGPL-3.0-only
import {
  CloseCode,
  type Member,
  PING_FRAME as PROTOCOL_PING_FRAME,
  PROTOCOL_VERSION,
  type WelcomePayload,
} from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  CLOSE,
  PING_FRAME,
  PING_INTERVAL_MS,
  PROTOCOL,
  QUOTA_CLOSE,
  QUOTA_RETRY_MS,
  retryDelay,
  RoomConnection,
  WELCOME_TIMEOUT_MS,
} from '../src/room/connection.ts';
import { FakeSocket } from './fake-socket.ts';

const ana: Member = { userId: 'u_ana', displayName: 'Ana', role: 'owner', canStream: true };
const bia: Member = { userId: 'u_bia', displayName: 'Bia', role: 'guest', canStream: false };

function welcome(overrides: Partial<WelcomePayload> = {}): WelcomePayload {
  return {
    protocol: { major: 1, minor: 0 },
    minProtocol: { major: 1, minor: 0 },
    serverTime: Date.now(),
    you: {
      userId: 'u_ana',
      connectionId: 'c_1',
      role: 'owner',
      permissions: { canStream: true, canModerate: true },
    },
    room: {
      roomId: 'rm_1',
      spaceId: 'sp_1',
      kind: 'fixed',
      visibility: 'space',
      name: 'Game night',
    },
    settings: { maxStreams: 4, maxViewersPerStream: 6, maxBitrateKbps: 8000, allowedPresets: [] },
    members: [ana],
    streams: [],
    ...overrides,
  };
}

let sockets: FakeSocket[];
const last = () => {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket');
  return socket;
};

function connect() {
  const connection = new RoomConnection({
    url: 'ws://localhost/ws/rooms/rm_1',
    tabId: 't_tab',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Upper end of the jitter, so delays are exact.
    random: () => 0.999_999,
  });
  connection.start();
  return connection;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('protocol constants copied from @openlive/protocol', () => {
  it('match the package', () => {
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
});

describe('RoomConnection', () => {
  it('says hello with the tab id, then shows the room and who is present', () => {
    const connection = connect();
    expect(connection.getState().status).toBe('connecting');
    last().open();
    expect(last().hello).toEqual({
      type: 'hello',
      id: '1',
      payload: {
        protocol: { major: 1, minor: 20 },
        client: 'web',
        clientVersion: expect.any(String),
        tabId: 't_tab',
      },
    });
    last().receive('welcome', welcome());
    const state = connection.getState();
    expect(state.status).toBe('open');
    expect(state.room?.name).toBe('Game night');
    expect(state.you?.role).toBe('owner');
    expect(state.members).toEqual([ana]);
  });

  it('follows member.joined, member.updated, member.left and permissions.changed', () => {
    const connection = connect();
    const listener = vi.fn();
    connection.subscribe(listener);
    last().open();
    last().receive('welcome', welcome());
    last().receive('member.joined', { member: bia });
    expect(connection.getState().members.map((m) => m.userId)).toEqual(['u_ana', 'u_bia']);
    last().receive('member.updated', { member: { ...bia, canStream: true } });
    expect(connection.getState().members[1]?.canStream).toBe(true);
    last().receive('member.left', { userId: 'u_bia' });
    expect(connection.getState().members).toEqual([ana]);
    last().receive('permissions.changed', {
      you: {
        ...welcome().you,
        role: 'admin',
        permissions: { canStream: true, canModerate: false },
      },
    });
    expect(connection.getState().you?.role).toBe('admin');
    expect(listener).toHaveBeenCalled();
    // Unknown and malformed frames are ignored.
    last().onmessage?.(new MessageEvent('message', { data: 'not json' }));
    last().receive('chat.message', { text: 'hi' });
    expect(connection.getState().members).toEqual([ana]);
  });

  it('pings every 30 s while open, and stops when closed', () => {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome());
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(last().sent.slice(1)).toEqual([PING_FRAME]);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(last().sent.slice(1)).toEqual([PING_FRAME, PING_FRAME]);
    connection.stop();
    expect(last().closedWith).toBe(1000);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(last().sent).toHaveLength(3);
  });

  it('kicked + 4004 ends for good with the reason, and does not reconnect', () => {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome({ members: [ana, bia] }));
    last().receive('kicked', { reason: 'banned' });
    last().serverClose(4004);
    expect(connection.getState()).toMatchObject({
      status: 'ended',
      ended: { kind: 'kicked', reason: 'banned' },
      members: [],
    });
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
  });

  it('room.closed + 4005 and 4006 end with their reasons', () => {
    const closed = connect();
    last().open();
    last().receive('welcome', welcome());
    last().receive('room.expiring', { expiresAt: 1_900_000_000_000 });
    expect(closed.getState().expiresAt).toBe(1_900_000_000_000);
    last().receive('room.closed', { reason: 'expired' });
    last().serverClose(4005);
    expect(closed.getState().ended).toEqual({ kind: 'closed', reason: 'expired' });

    const old = connect();
    last().open();
    last().receive('error', { code: 'protocol_unsupported', minProtocol: { major: 2, minor: 0 } });
    last().serverClose(4006);
    expect(old.getState().ended).toEqual({ kind: 'reload' });
    expect(old.getState().error?.code).toBe('protocol_unsupported');
  });

  it('a replaced tab (4002) waits until the user brings it back', () => {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome());
    last().serverClose(4002);
    expect(connection.getState().ended).toEqual({ kind: 'replaced' });
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
    connection.reconnect();
    expect(sockets).toHaveLength(2);
    expect(connection.getState()).toMatchObject({ status: 'connecting', ended: null });
  });

  it('reconnects with exponential backoff after other closes, and resets after a welcome', () => {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome());
    last().serverClose(1006);
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    // attempt 0: 500 ms, attempt 1: 1 s, attempt 2: 2 s.
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().serverClose(1006);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', attempt: 2 });
    last().open();
    expect(last().hello.payload['tabId']).toBe('t_tab');
    last().receive('welcome', welcome({ members: [ana, bia] }));
    expect(connection.getState()).toMatchObject({ status: 'open', attempt: 0 });
    expect(connection.getState().members).toHaveLength(2);
    // A deploy closes with 1000: also reconnect, from the shortest delay again.
    last().serverClose(1000);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
  });

  it('gives up on a socket that never answers hello, and reconnects', () => {
    const connection = connect();
    last().open();
    vi.advanceTimersByTime(WELCOME_TIMEOUT_MS);
    expect(last().closedWith).toBeUndefined();
    expect(last().readyState).toBe(3);
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    last().open();
    last().receive('welcome', welcome());
    vi.advanceTimersByTime(WELCOME_TIMEOUT_MS * 2);
    expect(connection.getState().status).toBe('open');
  });

  it('caps the backoff at 30 s and adds jitter', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(3, () => 0.999_999)).toBe(4000);
    expect(backoffDelay(20, () => 0.999_999)).toBe(BACKOFF_MAX_MS);
  });

  it('waits out the free-tier limit (do_quota_exceeded, close 1013) instead of retrying fast', () => {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome());
    last().serverClose(QUOTA_CLOSE);
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', quotaExceeded: true });
    vi.advanceTimersByTime(QUOTA_RETRY_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(QUOTA_RETRY_MS * 0.2 + 1);
    expect(sockets).toHaveLength(2);
    last().open();
    last().receive('welcome', welcome());
    expect(connection.getState()).toMatchObject({ status: 'open', quotaExceeded: false });
    expect(retryDelay(1006, 0, () => 0)).toBe(250);
    expect(retryDelay(QUOTA_CLOSE, 0, () => 0)).toBe(QUOTA_RETRY_MS);
  });

  it('stop() during a backoff wait cancels the retry', () => {
    const connection = connect();
    last().serverClose(1006);
    connection.stop();
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(sockets).toHaveLength(1);
  });
});

const STREAM = {
  streamId: 'st_1',
  userId: 'u_bia',
  deviceId: 'd_1',
  source: { kind: 'window' as const, label: 'Hades II' },
  preset: 'game' as const,
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 2,
  viewerCount: 1,
};

describe('RoomConnection viewer slots and queue (PROTOCOL 7.3)', () => {
  function open() {
    const connection = connect();
    last().open();
    last().receive('welcome', welcome({ streams: [STREAM] }));
    return connection;
  }

  it('requests a slot, renews it every leaseMs / 3 and releases it', () => {
    const connection = open();
    connection.watch('st_1');
    expect(connection.getState().access['st_1']).toEqual({ kind: 'requesting' });
    const request = last().requests.at(-1);
    expect(request).toMatchObject({ type: 'slot.request', payload: { streamId: 'st_1' } });
    last().receive(
      'slot.granted',
      { slotId: 'sl_1', streamId: 'st_1', expiresAt: 30_000, leaseMs: 30_000 },
      request?.id,
    );
    expect(connection.getState().access['st_1']).toMatchObject({ kind: 'granted', slotId: 'sl_1' });
    vi.advanceTimersByTime(10_000);
    expect(last().requests.at(-1)).toEqual({ type: 'slot.renew', payload: { slotId: 'sl_1' } });
    last().receive('slot.renewed', { slotId: 'sl_1', expiresAt: 40_000 });
    expect(connection.getState().access['st_1']).toMatchObject({ expiresAt: 40_000 });
    connection.unwatch('st_1');
    expect(last().requests.at(-1)).toEqual({ type: 'slot.release', payload: { slotId: 'sl_1' } });
    expect(connection.getState().access['st_1']).toBeUndefined();
    const sent = last().sent.length;
    vi.advanceTimersByTime(30_000);
    expect(
      last()
        .requests.slice(sent - 1)
        .some((r) => r.type === 'slot.renew'),
    ).toBe(false);
  });

  it('a full stream offers the queue: join, position, offer, accept, slot', () => {
    const connection = open();
    connection.watch('st_1');
    const request = last().requests.at(-1);
    last().receive('error', { code: 'viewer_limit_reached', limit: 2, used: 2 }, request?.id);
    expect(connection.getState().access['st_1']).toEqual({ kind: 'full', queue: null });

    connection.joinQueue('st_1');
    expect(connection.getState().access['st_1']).toEqual({ kind: 'full', queue: 'joining' });
    expect(last().requests.at(-1)).toMatchObject({
      type: 'queue.join',
      payload: { streamId: 'st_1' },
    });
    last().receive('queue.position', { streamId: 'st_1', position: 2, length: 3 });
    expect(connection.getState().access['st_1']).toEqual({
      kind: 'full',
      queue: { position: 2, length: 3 },
    });
    last().receive('queue.offer', { streamId: 'st_1', offerId: 'of_1', expiresAt: 99 });
    expect(connection.getState().access['st_1']).toEqual({
      kind: 'offer',
      offerId: 'of_1',
      expiresAt: 99,
    });

    connection.acceptOffer('st_1');
    const accept = last().requests.at(-1);
    expect(accept).toMatchObject({ type: 'queue.accept', payload: { offerId: 'of_1' } });
    last().receive(
      'slot.granted',
      { slotId: 'sl_9', streamId: 'st_1', expiresAt: 1, leaseMs: 30_000 },
      accept?.id,
    );
    expect(connection.getState().access['st_1']).toMatchObject({ kind: 'granted', slotId: 'sl_9' });
  });

  it('an expired offer goes back to the queue button; leaving sends queue.leave', () => {
    const connection = open();
    connection.watch('st_1');
    last().receive('error', { code: 'viewer_limit_reached' }, last().requests.at(-1)?.id);
    connection.joinQueue('st_1');
    last().receive('queue.offer', { streamId: 'st_1', offerId: 'of_1', expiresAt: 99 });
    last().receive('queue.left', { streamId: 'st_1', reason: 'offer_expired' });
    expect(connection.getState().access['st_1']).toEqual({ kind: 'full', queue: null });
    connection.joinQueue('st_1');
    last().receive('queue.position', { streamId: 'st_1', position: 1, length: 1 });
    connection.leaveQueue('st_1');
    expect(last().requests.at(-1)).toEqual({ type: 'queue.leave', payload: { streamId: 'st_1' } });
  });

  it('follows viewers, and remembers why a watched stream ended', () => {
    const connection = open();
    connection.watch('st_1');
    last().receive('viewers', {
      streamId: 'st_1',
      viewerUserIds: ['u_ana'],
      used: 1,
      limit: 2,
      queueLength: 0,
    });
    expect(connection.getState().viewers['st_1']?.used).toBe(1);
    last().receive('stream.ended', { streamId: 'st_1', reason: 'helper_disconnected' });
    const state = connection.getState();
    expect(state.streams).toEqual([]);
    expect(state.viewers['st_1']).toBeUndefined();
    expect(state.access['st_1']).toBeUndefined();
    expect(state.endedStreams['st_1']).toBe('helper_disconnected');
  });

  it('gives back a slot granted after leaving, and asks again after a reconnect', () => {
    const connection = open();
    connection.watch('st_1');
    connection.unwatch('st_1');
    last().receive('slot.granted', {
      slotId: 'sl_late',
      streamId: 'st_1',
      expiresAt: 1,
      leaseMs: 30_000,
    });
    expect(last().requests.at(-1)).toEqual({
      type: 'slot.release',
      payload: { slotId: 'sl_late' },
    });

    connection.watch('st_1');
    last().receive('slot.granted', {
      slotId: 'sl_2',
      streamId: 'st_1',
      expiresAt: 1,
      leaseMs: 30_000,
    });
    last().serverClose(1006);
    expect(connection.getState().access).toEqual({});
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    last().open();
    last().receive('welcome', welcome({ streams: [STREAM] }));
    expect(last().requests.at(-1)).toMatchObject({
      type: 'slot.request',
      payload: { streamId: 'st_1' },
    });
    expect(connection.getState().access['st_1']).toEqual({ kind: 'requesting' });
  });

  it('a refused request shows why; access revoked denies', () => {
    const connection = open();
    connection.watch('st_1');
    last().receive('error', { code: 'forbidden' }, last().requests.at(-1)?.id);
    expect(connection.getState().access['st_1']).toEqual({ kind: 'denied', code: 'forbidden' });
    connection.watch('st_1');
    last().receive('slot.granted', {
      slotId: 'sl_3',
      streamId: 'st_1',
      expiresAt: 1,
      leaseMs: 30_000,
    });
    last().receive('slot.released', { slotId: 'sl_3', streamId: 'st_1', reason: 'access_revoked' });
    expect(connection.getState().access['st_1']).toEqual({ kind: 'denied', code: 'forbidden' });
  });
});
