// SPDX-License-Identifier: AGPL-3.0-only
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BREAKER_CLOSE_CODE,
  BREAKER_COOLDOWN_MS,
  BREAKER_LIMITS,
  BREAKER_OPEN_ERROR,
  BREAKER_PER_SOCKET,
  breakerOf,
  CircuitBreaker,
  isBreakerOpenError,
  SOCKET_MESSAGE_BURST,
} from '../src/do/breaker';
import { PING_RATE_PER_S } from '../src/do/room';
import { DEV_USER_HEADER } from '../src/room/identity';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, roomStub, seed, upgrade, USERS } from './room-helpers';

// The per-object circuit breaker of src/do/breaker.ts. The normal-group scenario
// never tripping is checked in free-tier.test.ts, on the same objects the budgets measure.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

/** A stand-in for the object's state: the breaker only uses kv, deleteAlarm and id. */
function fakeState() {
  const kv = new Map<string, unknown>();
  const deleteAlarm = vi.fn(async () => {});
  const state = {
    id: { toString: () => 'do-id' },
    storage: {
      kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v) },
      deleteAlarm,
    },
  } as unknown as DurableObjectState;
  return { state, kv, deleteAlarm };
}

function metrics() {
  const writeDataPoint = vi.fn();
  return { env: { METRICS: { writeDataPoint } } as unknown as Env, writeDataPoint };
}

describe('CircuitBreaker', () => {
  it('trips past a kind per minute: stops the alarm, logs and measures once, and stays open', () => {
    const { state, kv, deleteAlarm } = fakeState();
    const { env, writeDataPoint } = metrics();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new CircuitBreaker({}, state, env, {
      object: 'RoomDO',
      scope: () => ({ spaceId: 's1', roomId: 'r1' }),
      metricId: () => 'r1',
    });
    const t0 = 1_000_000;
    for (let i = 0; i < BREAKER_LIMITS.alarm.minute; i++) {
      expect(b.enter('alarm', t0 + i * 10)).toBe(true);
    }
    expect(b.enter('alarm', t0 + 2_000)).toBe(false);
    expect(b.isOpen(t0 + 2_000)).toBe(true);
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
    expect(kv.get('breaker_open_until')).toBe(t0 + 2_000 + BREAKER_COOLDOWN_MS);
    // Open: every kind is refused, and nothing more is logged or measured.
    for (let i = 0; i < 500; i++) {
      expect(b.enter(i % 2 ? 'message' : 'request', t0 + 3_000 + i)).toBe(false);
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]?.[0] as { blobs: string[]; doubles: number[] };
    expect(point.blobs).toEqual(['breaker', 's1', 'r1', '', 'RoomDO', 'r1', 'alarm', 'minute']);
    expect(point.doubles).toEqual([BREAKER_LIMITS.alarm.minute + 1, 0, 0, 600]);
    expect(b.trips).toBe(1);
  });

  it('resumes after the cool-down, with fresh counts', () => {
    const { state } = fakeState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new CircuitBreaker({}, state, {} as Env, { object: 'SpaceDO' });
    const t0 = 5_000_000;
    for (let i = 0; i <= BREAKER_LIMITS.request.minute; i++) b.enter('request', t0);
    expect(b.isOpen(t0)).toBe(true);
    expect(b.enter('request', t0 + BREAKER_COOLDOWN_MS - 1)).toBe(false);
    expect(b.enter('request', t0 + BREAKER_COOLDOWN_MS)).toBe(true);
    expect(b.isOpen(t0 + BREAKER_COOLDOWN_MS)).toBe(false);
  });

  it('keeps a trip across an eviction (a new instance reads it once)', () => {
    const { state } = fakeState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = 9_000_000;
    const first = new CircuitBreaker({}, state, {} as Env, { object: 'UserHubDO' });
    for (let i = 0; i <= BREAKER_LIMITS.message.minute; i++) first.enter('message', t0);
    const second = new CircuitBreaker({}, state, {} as Env, { object: 'UserHubDO' });
    expect(second.enter('message', t0 + 1)).toBe(false);
    expect(second.enter('message', t0 + BREAKER_COOLDOWN_MS)).toBe(true);
  });

  it('trips on the total, and on the hour window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const total = new CircuitBreaker({}, fakeState().state, {} as Env, { object: 'RoomDO' });
    const t0 = 20_000_000;
    let tripped = -1;
    for (let i = 0; i < 4_000 && tripped < 0; i++) {
      if (!total.enter(i % 2 ? 'message' : 'request', t0)) tripped = i;
    }
    expect(tripped).toBe(BREAKER_LIMITS.total.minute);

    // 21 alarms a minute never trip the minute window, but trip the hour's past 1,200.
    const hour = new CircuitBreaker({}, fakeState().state, {} as Env, { object: 'RoomDO' });
    let served = 0;
    for (let m = 0; m < 60; m++) {
      for (let k = 0; k < 21; k++) if (hour.enter('alarm', t0 + m * 60_000 + k)) served += 1;
    }
    expect(served).toBe(BREAKER_LIMITS.alarm.hour);
    expect(hour.isOpen(t0 + 59 * 60_000)).toBe(true);
  });

  it('a socket past its own rate is refused alone; the object stays closed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new CircuitBreaker({}, fakeState().state, {} as Env, { object: 'RoomDO' });
    const t0 = 30_000_000;
    for (let i = 0; i < SOCKET_MESSAGE_BURST; i++) expect(b.socketMessage('c_a', t0)).toBe(true);
    expect(b.socketMessage('c_a', t0)).toBe(false);
    expect(b.socketMessage('c_b', t0)).toBe(true);
    expect(b.isOpen(t0)).toBe(false);
    // A steady 5 a second (a busy tab) never empties the bucket.
    for (let i = 0; i < 3_000; i++) expect(b.socketMessage('c_c', t0 + i * 200)).toBe(true);
  });

  it('recognizes its error through the RPC boundary', () => {
    expect(isBreakerOpenError(new Error(BREAKER_OPEN_ERROR))).toBe(true);
    expect(isBreakerOpenError(new Error('Error: ' + BREAKER_OPEN_ERROR))).toBe(true);
    expect(isBreakerOpenError(new Error('something else'))).toBe(false);
  });
});

/**
 * An hour of a room of `users` people, each with one room socket, everyone using everything at
 * once: pointer pings at the allowed PING_RATE_PER_S the whole hour, a lease renewal every 30 s,
 * a chat message in the room every 2 s with a read receipt from everyone else, a mute toggle per
 * person every 5 minutes (a presence change; two in a second cost a debounce alarm), the 5-minute
 * tick, and
 * the REST calls: 6 per person at the start (session, subscribe, voice) and a thumbnail per
 * stream (5) every 10 s. Returns whether anything tripped.
 */
function busiestHour(users: number): { tripped: boolean; socketsClosed: number; messages: number } {
  const b = new CircuitBreaker({}, fakeState().state, {} as Env, {
    object: 'RoomDO',
    sockets: () => users,
  });
  const t0 = 50_000_000;
  let tripped = false;
  let socketsClosed = 0;
  let messages = 0;
  const enter = (kind: 'alarm' | 'request' | 'message', at: number) => {
    if (!b.enter(kind, at)) tripped = true;
  };
  const message = (user: number, at: number) => {
    messages += 1;
    enter('message', at);
    if (!b.socketMessage(`c_${user}`, at)) socketsClosed += 1;
  };
  for (let u = 0; u < users; u++) b.connected();
  for (let u = 0; u < users * 6; u++) enter('request', t0);
  for (let s = 0; s < 3_600; s++) {
    const at = t0 + s * 1_000;
    let changes = 0;
    for (let u = 0; u < users; u++) {
      for (let p = 0; p < PING_RATE_PER_S; p++) message(u, at + p * (1_000 / PING_RATE_PER_S) + u);
      if ((s + u) % 30 === 0) message(u, at + 5);
      if ((s + u) % 300 === 0) {
        message(u, at + 7);
        changes += 1;
      }
    }
    // A presence change is pushed at once; a second one within PRESENCE_DEBOUNCE_MS (1 s) waits
    // for one alarm.
    if (changes > 1) enter('alarm', at + 1_007);
    if (s % 2 === 0) {
      const author = (s / 2) % users;
      message(author, at + 9);
      for (let u = 0; u < users; u++) if (u !== author) message(u, at + 11);
    }
    if (s % 10 === 0) for (let k = 0; k < 5; k++) enter('request', at + 13);
    if (s % 300 === 0) enter('alarm', at + 15);
  }
  return { tripped, socketsClosed, messages };
}

describe('CircuitBreaker in the busiest legitimate room', () => {
  it('never trips for an hour, from 2 people to the 50-viewer ceiling', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const messages = new Map<number, number>();
    for (const users of [2, 13, 50]) {
      const r = busiestHour(users);
      expect({ users, tripped: r.tripped, socketsClosed: r.socketsClosed }).toEqual({
        users,
        tripped: false,
        socketsClosed: 0,
      });
      messages.set(users, r.messages);
    }
    // Two people already pass the fixed base an hour, and 13 people pinging the base a minute:
    // without the per-socket share these rooms would trip.
    expect(messages.get(2)).toBeGreaterThan(BREAKER_LIMITS.message.hour);
    expect(13 * PING_RATE_PER_S * 60).toBeGreaterThan(BREAKER_LIMITS.message.minute);
  });

  it('still trips when every socket of a room loops just under its own bucket', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const users = 20;
    const b = new CircuitBreaker({}, fakeState().state, {} as Env, {
      object: 'RoomDO',
      sockets: () => users,
    });
    for (let u = 0; u < users; u++) b.connected();
    const t0 = 60_000_000;
    let at = -1;
    // 9.5 a second per socket: no bucket empties and no minute trips, but the hour does.
    for (let i = 0; i < 9.5 * 3_600 * users && at < 0; i++) {
      const now = t0 + Math.floor(i / users / 9.5) * 1_000 + (i % users);
      if (!b.enter('message', now)) at = i;
    }
    expect(at).toBe(BREAKER_LIMITS.message.hour + BREAKER_PER_SOCKET.hour * users);
  });
});

describe('RoomDO circuit breaker', () => {
  it('a looping alarm trips it: the alarm stops re-arming, everything is refused, then it resumes', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const roomId = await newRoom();
    const stub = roomStub(roomId);
    const { client: other } = await Client.join(roomId, USERS.member1.id);
    // A runaway: the alarm re-armed in the past every time it ran (the 2026-11-07 incident).
    let alarms = 0;
    while (alarms < BREAKER_LIMITS.alarm.minute + 5) {
      now += 50;
      const open = await runInDurableObject(stub, async (instance, state) => {
        if (breakerOf(instance)?.isOpen()) return true;
        await state.storage.setAlarm(now + 60_000);
        return false;
      });
      if (open) break;
      await runDurableObjectAlarm(stub);
      alarms += 1;
    }
    // The alarm past the limit tripped it and did nothing.
    expect(alarms).toBe(BREAKER_LIMITS.alarm.minute + 1);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
    const trips = errors.mock.calls.filter(
      (c) => c[0] === 'durable object circuit breaker tripped',
    );
    expect(trips).toHaveLength(1);

    // While open: an alarm does nothing and sets none, RPC is refused, a socket is closed 1013.
    await runInDurableObject(stub, (_, state) => state.storage.setAlarm(now + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
    expect(await rpcError(() => stub.liveStreamIds())).toContain(BREAKER_OPEN_ERROR);
    other.raw(JSON.stringify({ type: 'queue.leave', id: '9', payload: { streamId: 'x' } }));
    expect(await other.closed).toEqual({ code: BREAKER_CLOSE_CODE });
    const refused = Client.adopt(await upgrade(roomId, USERS.member2.id));
    expect(await refused.closed).toEqual({ code: BREAKER_CLOSE_CODE });
    // The REST routes answer as for the quota, for the cool-down.
    const rest = await viewerSession(roomId);
    expect(rest.status).toBe(503);
    expect(rest.headers.get('Retry-After')).toBe(String(BREAKER_COOLDOWN_MS / 1000));
    expect(trips).toHaveLength(1);

    // After the cool-down the next event is served as usual.
    now += BREAKER_COOLDOWN_MS;
    expect(await stub.liveStreamIds()).toEqual([]);
    const { client } = await Client.join(roomId, USERS.member2.id);
    expect((await client.request('queue.leave', { streamId: 'x' })).type).toBe('ack');
  }, 30_000);

  it('a room of 14 people all pinging at the allowed rate for a minute stays open', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const roomId = await newRoom();
    const stub = roomStub(roomId);
    const people = [USERS.owner, USERS.admin, USERS.member1, USERS.member2, USERS.guest1];
    const clients: Client[] = [];
    for (let i = 0; i < 14; i++) {
      const who = people[i % people.length] ?? USERS.member1;
      clients.push((await Client.join(roomId, who.id)).client);
    }
    // 14 x 4 a second x 60 s = 3,360 messages: more than the fixed base of 3,000 a minute.
    const ping = { streamId: 'st_x', x: 0.5, y: 0.5, style: { color: 'olive', shape: 'ring' } };
    for (let round = 0; round < PING_RATE_PER_S * 60; round++) {
      now += 1_000 / PING_RATE_PER_S;
      await Promise.all(clients.map((c) => c.request('pointer.ping', ping as never)));
    }
    expect(await runInDurableObject(stub, (i) => breakerOf(i)?.isOpen())).toBe(false);
    for (const c of clients) {
      expect((await c.request('queue.leave', { streamId: 'x' })).type).toBe('ack');
    }
  }, 60_000);

  it('works with the limits brake: brakeSleep reaches a tripped room, a dormant one is not counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Tripped first: the brake's RPC is not guarded, so it still puts the room to sleep.
    const tripped = roomStub(await newRoom());
    await runInDurableObject(tripped, (instance) => {
      const b = breakerOf(instance);
      for (let i = 0; i <= BREAKER_LIMITS.alarm.minute; i++) b?.enter('alarm');
      expect(b?.isOpen()).toBe(true);
    });
    expect(await tripped.brakeSleep(Date.now() + 60_000)).toBe(0);

    // Dormant first: alarms stop at the brake's check, before the breaker counts them.
    const dormant = roomStub(await newRoom());
    await dormant.brakeSleep(Date.now() + 60 * 60_000);
    for (let i = 0; i < BREAKER_LIMITS.alarm.minute + 10; i++) {
      await runInDurableObject(dormant, (_, state) => state.storage.setAlarm(Date.now() + 60_000));
      await runDurableObjectAlarm(dormant);
    }
    const state = await runInDurableObject(dormant, (instance) => ({
      open: breakerOf(instance)?.isOpen(),
      trips: breakerOf(instance)?.trips,
    }));
    expect(state).toEqual({ open: false, trips: 0 });
  }, 30_000);

  it('a message flood on one socket closes only that socket', async () => {
    const roomId = await newRoom();
    const stub = roomStub(roomId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client: flood } = await Client.join(roomId, USERS.member1.id);
    const { client: calm } = await Client.join(roomId, USERS.member2.id);
    for (let i = 0; i < SOCKET_MESSAGE_BURST + 50; i++) {
      flood.raw(JSON.stringify({ type: 'x.unknown', payload: {} }));
    }
    expect(await flood.closed).toEqual({ code: BREAKER_CLOSE_CODE });
    // The others are served, and the object is not tripped.
    expect((await calm.request('queue.leave', { streamId: 'x' })).type).toBe('ack');
    await calm.take('member.left', (m) => m.payload.userId === USERS.member1.id);
    expect(await runInDurableObject(stub, (i) => breakerOf(i)?.isOpen())).toBe(false);
    const trips = errors.mock.calls.filter(
      (c) =>
        c[0] === 'durable object circuit breaker tripped' &&
        (c[1] as { cause?: string } | undefined)?.cause === 'socket',
    );
    expect(trips).toHaveLength(1);
    expect(trips[0]?.[1]).toMatchObject({ object: 'RoomDO', cause: 'socket' });
  });
});

/** The error message of an RPC call that must fail. */
async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the call did not fail');
}

/** A REST route served by one room RPC: POST /api/rtc/rooms/:id/session. */
function viewerSession(roomId: string): Promise<Response> {
  new FakeSfu().install();
  return exports.default.fetch(`http://localhost/api/rtc/rooms/${roomId}/session`, {
    method: 'POST',
    headers: { [DEV_USER_HEADER]: USERS.member1.id, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionDescription: offer }),
  });
}
