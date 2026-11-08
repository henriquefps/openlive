// SPDX-License-Identifier: AGPL-3.0-only
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { breakerOf } from '../src/do/breaker';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { FREE_TIER_BUDGET, type Budget } from './free-tier-budget';
import { type SqlRecord, type Totals, UsageCounter } from './write-counter';
import {
  DEFAULT_LOG_SAMPLING,
  FREE_TIER_DAILY,
  logEvents,
  LOGS_FREE_DAILY,
} from '../src/usage/free-tier';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// What normal use costs against the Workers Free daily limits (src/usage/free-tier.ts):
// a fake clock drives a room with a stream, viewers renewing their slots as the web does, people
// in voice, a few chat messages, the space sidebar and the hub, and test/write-counter.ts counts
// Durable Object rows written and read, DO requests, D1 rows, Worker requests and console lines
// (with the invocations, the Workers Logs events). The budgets in
// test/free-tier-budget.ts fail the test on a regression.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const CAPS = { stream: true, voice: true, camera: false, text: true };
const HELPER = { user: USERS.member1.id, device: 'd_writes_pc' };
const PROTOCOL = { major: 1, minor: 22 };
const TRACKS = [
  { mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
  { mid: '1', trackName: 'audio', kind: 'audio' },
] as const;
const PUBLISH = { sessionDescription: offer, tracks: TRACKS, preset: 'game', maxBitrateKbps: 9000 };
/** A data channel (mid 0) and a sendonly microphone (mid 1). */
const MIC_OFFER = {
  type: 'offer' as const,
  sdp: [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    'a=sendonly',
    '',
  ].join('\r\n'),
};

async function rest(
  method: string,
  path: string,
  who: { user: string; device?: string },
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { [DEV_USER_HEADER]: who.user };
  if (who.device) headers[DEV_DEVICE_HEADER] = who.device;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function socket(path: string, user: string, device?: string): Promise<Client> {
  const headers: Record<string, string> = { Upgrade: 'websocket', [DEV_USER_HEADER]: user };
  if (device) headers[DEV_DEVICE_HEADER] = device;
  const res = await exports.default.fetch(`http://localhost${path}`, { headers });
  expect(res.status).toBe(101);
  return Client.adopt(res);
}

/** A web tab's hub and space sockets, as the web app keeps them open. */
async function sidebar(user: string): Promise<Client[]> {
  const tabId = `t_${crypto.randomUUID().slice(0, 8)}`;
  const hub = await socket('/ws/hub', user);
  const hello = { protocol: PROTOCOL, client: 'web' as const, clientVersion: '0.1.0', tabId };
  expect((await hub.request('hello', hello)).type).toBe('hub.welcome');
  const space = await socket(`/ws/spaces/${SPACE_ID}`, user);
  space.send('hello', hello);
  await space.take('space.presence');
  return [hub, space];
}

interface Shape {
  viewers: number;
  voice: number;
  chatMessages: number;
  /** voice.state changes per voice participant. */
  muteToggles: number;
  minutes: number;
  /** Space sidebar and hub sockets for every web tab (the web app keeps both open). */
  sidebar?: boolean;
}

interface Person {
  user: string;
  client: Client;
  sessionId: string;
  slotId?: string;
}

/**
 * Where every scenario's fake clock starts (a Tuesday noon UTC). Far in the future on purpose:
 * workerd fires Durable Object alarms by the wall clock, so a fake clock behind the real one makes
 * every alarm due at once and the rooms rewrite their rows in a loop (this failed from the
 * afternoon of the old start date on).
 */
const START_AT = Date.UTC(2099, 0, 6, 12, 0, 0);

/**
 * The SpaceDO of the test space outlives a test (its storage is not isolated per test): the
 * presence rows and alarm a previous scenario left, stamped with its fake clock, would change how
 * often this one moves the alarm (3 times a day after another scenario, 49 alone). Starts clean.
 */
async function resetSpace(): Promise<void> {
  const space = env.SPACE.get(env.SPACE.idFromName(SPACE_ID));
  await runInDurableObject(space, async (_i, state) => {
    state.storage.sql.exec('DELETE FROM room_presence');
    await state.storage.deleteAlarm();
  });
}

/** Runs `shape` on a fake clock and returns what it cost. */
async function scenario(
  shape: Shape,
): Promise<{ report: SqlRecord[]; counter: UsageCounter; trips: number }> {
  const sfu = new FakeSfu().install();
  const counter = new UsageCounter().install();
  // A fixed start, not the wall clock: the cost must not depend on the time of day it runs.
  let now = START_AT;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await resetSpace();
  const roomId = await newRoom({ settings: { capabilities: CAPS } });
  const room = roomStub(roomId);
  await counter.attach(room, 'RoomDO');
  await counter.attach(env.SPACE.get(env.SPACE.idFromName(SPACE_ID)), 'SpaceDO');
  // Every object the scenario uses, for the circuit breaker check at the end.
  const objects: DurableObjectStub[] = [room, env.SPACE.get(env.SPACE.idFromName(SPACE_ID))];

  // Everyone: the streamer's web tab first, then viewers and voice from the other seeded users.
  const others = [USERS.owner, USERS.admin, USERS.member2, USERS.guest1, USERS.guest2];
  const users = [USERS.member1.id, ...others.map((u) => u.id)].slice(
    0,
    Math.max(shape.viewers + 1, shape.voice),
  );
  for (const user of users) {
    await counter.attach(env.USER_HUB.get(env.USER_HUB.idFromName(user)), 'UserHubDO');
    objects.push(env.USER_HUB.get(env.USER_HUB.idFromName(user)));
  }
  objects.push(env.USER_HUB.get(env.USER_HUB.idFromName(HELPER.user)));
  const deviceRow = await env.DB.prepare('SELECT id FROM devices WHERE id = ?')
    .bind(HELPER.device)
    .first();
  if (!deviceRow) {
    await env.DB.prepare(
      `INSERT INTO devices (id, user_id, name, os, arch, helper_version, token_hash, created_at)
       VALUES (?, ?, 'PC', 'linux', 'amd64', '0.1.0', ?, ?)`,
    )
      .bind(HELPER.device, HELPER.user, crypto.randomUUID(), now)
      .run();
  }

  const sockets: Client[] = [];
  // The streamer's helper: hub, then publish and announce.
  const helperHub = await socket('/ws/hub', HELPER.user, HELPER.device);
  sockets.push(helperHub);
  await helperHub.request('hello', {
    protocol: PROTOCOL,
    client: 'helper',
    clientVersion: '0.2.0',
    deviceId: HELPER.device,
  });
  helperHub.raw(
    JSON.stringify({ type: 'helper.status', payload: { deviceId: HELPER.device, state: 'idle' } }),
  );
  const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
  expect(pub.status).toBe(201);
  const { client: helper } = await Client.join(roomId, HELPER.user, {
    client: 'helper',
    deviceId: HELPER.device,
  });
  sockets.push(helper);
  const started = await helper.request('stream.announce', {
    sfuSessionId: pub.body.sfuSessionId,
    source: { kind: 'screen', label: 'Screen 1' },
    preset: 'game',
    hasAudio: true,
    tracks: [
      { name: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
      { name: 'audio', kind: 'audio' },
    ],
  });
  if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
  const streamId = started.payload.stream.streamId;
  helperHub.raw(
    JSON.stringify({
      type: 'helper.status',
      payload: {
        deviceId: HELPER.device,
        state: 'live',
        stream: { roomId, streamId, sourceId: 'screen1', preset: 'game' },
      },
    }),
  );

  // Web tabs: the sidebar sockets, the room, a viewer session.
  const people: Person[] = [];
  for (const user of users) {
    if (shape.sidebar !== false) sockets.push(...(await sidebar(user)));
    const session = await rest(
      'POST',
      `/rtc/rooms/${roomId}/session`,
      { user },
      {
        sessionDescription: offer,
      },
    );
    expect(session.status).toBe(201);
    const { client } = await Client.join(roomId, user);
    sockets.push(client);
    people.push({ user, client, sessionId: session.body.sessionId });
  }
  // Viewers (not the streamer): a slot and the stream pulled.
  const viewers = people.slice(1, 1 + shape.viewers);
  let leaseMs = 0;
  for (const v of viewers) {
    const grant = await v.client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error(JSON.stringify(grant));
    v.slotId = grant.payload.slotId;
    leaseMs = grant.payload.leaseMs;
    const sub = await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: v.user },
      {
        sessionId: v.sessionId,
        slotId: v.slotId,
        streamId,
      },
    );
    expect(sub.status).toBe(200);
  }
  // Voice: everyone speaks and hears everyone else.
  const voice = people.slice(0, shape.voice);
  const trackIds = new Map<string, string>();
  for (const p of voice) {
    expect((await p.client.request('voice.join', {})).type).toBe('voice.joined');
    const mic = await rest(
      'POST',
      `/rtc/rooms/${roomId}/voice/publish`,
      { user: p.user },
      {
        sessionId: p.sessionId,
        sessionDescription: MIC_OFFER,
        mid: '1',
      },
    );
    expect(mic.status).toBe(201);
    trackIds.set(p.user, mic.body.trackId);
  }
  for (const p of voice) {
    const ids = voice.filter((o) => o !== p).map((o) => trackIds.get(o.user) ?? '');
    if (ids.length === 0) continue;
    const res = await rest(
      'POST',
      `/rtc/rooms/${roomId}/voice/subscribe`,
      { user: p.user },
      {
        sessionId: p.sessionId,
        trackIds: ids,
      },
    );
    expect(res.status).toBe(200);
  }

  // The time: renewals every leaseMs / 3 as the web sends them, chat and mutes spread over it,
  // and the alarm run whenever it is due.
  const step = Math.max(1_000, Math.floor(leaseMs / 3));
  const start = now;
  const end = start + shape.minutes * 60_000;
  const at = (n: number, i: number) => start + Math.floor(((i + 0.5) * (end - start)) / n);
  const chatAt = Array.from({ length: shape.chatMessages }, (_, i) => at(shape.chatMessages, i));
  const muteAt = Array.from({ length: shape.muteToggles }, (_, i) => at(shape.muteToggles, i));
  let chatIndex = 0;
  let muteIndex = 0;
  let muted = false;
  const runDueAlarms = async () => {
    // As workerd would (the fake clock is ahead of the real one): the alarm fires at its time.
    for (;;) {
      const alarm = await runInDurableObject(room, (_i, state) => state.storage.getAlarm());
      if (alarm === null || alarm > now) break;
      await counter.runAlarm(room);
    }
  };
  while (now < end) {
    now += step;
    await runDueAlarms();
    for (const v of viewers) {
      const r = await v.client.request('slot.renew', { slotId: v.slotId ?? '' });
      expect(r.type).toBe('slot.renewed');
    }
    while (chatIndex < chatAt.length && (chatAt[chatIndex] ?? end) <= now) {
      const author = people[chatIndex % people.length];
      chatIndex += 1;
      if (!author) continue;
      const sent = await author.client.request('chat.send', {
        text: `hello ${chatIndex}`,
        clientId: `c${chatIndex}`,
      });
      if (sent.type !== 'chat.message') throw new Error(JSON.stringify(sent));
      for (const p of people) {
        if (p === author) continue;
        await p.client.take('chat.message');
        await p.client.request('chat.read', { messageId: sent.payload.message.id });
      }
    }
    while (muteIndex < muteAt.length && (muteAt[muteIndex] ?? end) <= now) {
      muteIndex += 1;
      muted = !muted;
      for (const p of voice) {
        await p.client.request('voice.state', { muted, deafened: false });
      }
    }
    await runDueAlarms();
  }
  counter.pause();
  // Real use never trips a circuit breaker, see src/do/breaker.ts.
  let trips = 0;
  for (const stub of objects) {
    trips += await runInDurableObject(stub, (instance) => {
      const breaker = breakerOf(instance);
      return (breaker?.trips ?? 0) + (breaker?.isOpen() ? 1 : 0);
    });
  }
  for (const s of sockets) s.close();
  void sfu;
  return { report: counter.report(), counter, trips };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Every invocation is one log event: Worker requests, DO requests and WebSocket messages. */
const invocations = (t: Totals) => t.workerRequests + t.doRequests + t.doWsMessages;
/** Workers Logs events, unsampled. */
const unsampledLogEvents = (t: Totals) => logEvents(invocations(t), t.consoleLines, 1);
/** The cron runs every 5 minutes: 288 invocations a day, silent when nothing happens. */
const CRON_RUNS_PER_DAY = 288;

function table(title: string, report: SqlRecord[], t: Totals, days = 1): string {
  const rows = report
    .filter((r) => r.rowsWritten > 0)
    .map((r) => `| ${r.object} | ${r.source} | ${r.statements} | ${fmt(r.rowsWritten)} |`);
  const limits = [
    ['DO rows written', t.doRowsWritten, FREE_TIER_DAILY.doRowsWritten],
    ['DO rows read', t.doRowsRead, FREE_TIER_DAILY.doRowsRead],
    [
      'DO requests (WebSocket messages 1:1)',
      t.doRequests + t.doWsMessages,
      FREE_TIER_DAILY.doRequests,
    ],
    [
      'DO requests (WebSocket messages 20:1)',
      t.doRequests + t.doWsMessages / 20,
      FREE_TIER_DAILY.doRequests,
    ],
    ['D1 rows written', t.d1RowsWritten, FREE_TIER_DAILY.d1RowsWritten],
    ['D1 rows read', t.d1RowsRead, FREE_TIER_DAILY.d1RowsRead],
    ['Worker requests', t.workerRequests, FREE_TIER_DAILY.workerRequests],
    ['Workers Logs events, unsampled', unsampledLogEvents(t), LOGS_FREE_DAILY],
    [
      `Workers Logs events at ${DEFAULT_LOG_SAMPLING} sampling`,
      unsampledLogEvents(t) * DEFAULT_LOG_SAMPLING,
      LOGS_FREE_DAILY,
    ],
  ] as const;
  return [
    `### ${title}`,
    '| Object | Source of writes | Statements | Rows written |',
    '| --- | --- | ---: | ---: |',
    ...rows,
    `| **all** | | | **${fmt(t.doRowsWritten)}** |`,
    '',
    `Console lines: ${t.consoleLines}`,
    '',
    `| Free-tier metric | This run | Per day (x${days}) | Daily limit | Share |`,
    '| --- | ---: | ---: | ---: | ---: |',
    ...limits.map(
      ([name, v, limit]) =>
        `| ${name} | ${fmt(v)} | ${fmt(v * days)} | ${fmt(limit)} | ${((100 * v * days) / limit).toFixed(1)} % |`,
    ),
  ].join('\n');
}

function check(counter: UsageCounter, budget: Budget): void {
  const t = counter.totals();
  for (const [object, max] of Object.entries(budget.doRowsWrittenBy)) {
    expect(counter.rowsWrittenBy(object), `${object} rows written`).toBeLessThanOrEqual(max);
  }
  expect(t.doRowsWritten, 'DO rows written').toBeLessThanOrEqual(budget.doRowsWritten);
  expect(t.doRowsRead, 'DO rows read').toBeLessThanOrEqual(budget.doRowsRead);
  expect(t.doRequests + t.doWsMessages, 'DO requests').toBeLessThanOrEqual(budget.doRequests);
  expect(t.d1RowsWritten, 'D1 rows written').toBeLessThanOrEqual(budget.d1RowsWritten);
  expect(t.d1RowsRead, 'D1 rows read').toBeLessThanOrEqual(budget.d1RowsRead);
  expect(t.workerRequests, 'Worker requests').toBeLessThanOrEqual(budget.workerRequests);
  expect(unsampledLogEvents(t), 'Workers Logs events').toBeLessThanOrEqual(budget.logEvents);
  // Warnings and errors only: nothing logs per message, renewal or tick.
  expect(t.consoleLines, 'console lines').toBe(0);
}

describe('free-tier budget', () => {
  it('an hour of a room: 1 streamer, 3 viewers, 3 in voice, chat, sidebar and hub', async () => {
    const { report, counter, trips } = await scenario({
      viewers: 3,
      voice: 3,
      chatMessages: 6,
      muteToggles: 4,
      minutes: 60,
    });
    console.log(table('One hour of a room', report, counter.totals()));
    check(counter, FREE_TIER_BUDGET.hour);
    expect(trips, 'circuit breaker trips').toBe(0);
  }, 300_000);

  it('a normal group: 5 friends, 1 streams, 4 watch, all in voice, 3 hours a day', async () => {
    const { report, counter, trips } = await scenario({
      viewers: 4,
      voice: 5,
      chatMessages: 20,
      muteToggles: 6,
      minutes: 60,
    });
    console.log(table('A normal group, one hour (x3 for 3 h a day)', report, counter.totals(), 3));
    check(counter, FREE_TIER_BUDGET.groupHour);
    expect(trips, 'circuit breaker trips').toBe(0);
    // The day: three such hours, each with its setup, well inside every limit.
    const t = counter.totals();
    expect(t.doRowsWritten * 3).toBeLessThan(FREE_TIER_BUDGET.groupDayDoRowsWritten);
    // Workers Logs: three hours and a day of cron runs, at the template's sampling rate.
    const dayLogEvents = (unsampledLogEvents(t) * 3 + CRON_RUNS_PER_DAY) * DEFAULT_LOG_SAMPLING;
    console.log(`Workers Logs events a day at ${DEFAULT_LOG_SAMPLING}: ${fmt(dayLogEvents)}`);
    expect(dayLogEvents).toBeLessThan(FREE_TIER_BUDGET.groupDayLogEvents);
    expect(FREE_TIER_BUDGET.groupDayLogEvents).toBeLessThan(LOGS_FREE_DAILY);
  }, 300_000);

  it('a tab left open: 1 stream, 1 viewer, 24 hours', async () => {
    const { report, counter, trips } = await scenario({
      viewers: 1,
      voice: 0,
      chatMessages: 0,
      muteToggles: 0,
      minutes: 24 * 60,
      sidebar: false,
    });
    console.log(table('A tab left open for a day', report, counter.totals()));
    check(counter, FREE_TIER_BUDGET.idleDay);
    expect(trips, 'circuit breaker trips').toBe(0);
  }, 600_000);
});
