// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// Brake 3 enforced (docs/PROTOCOL.md 7.2 "Economy mode"): above 90 % of the
// monthly limit, publishes get a quality cap, every StreamInfo carries it, new pulls start on the
// middle layer, and running streams hear about it at the next meter flush.

const CAP = { maxHeight: 1080, maxBitrateKbps: 8000 };
const HELPER = { user: USERS.member1.id, device: 'd_eco1' };

beforeAll(seed);
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare('DELETE FROM usage_daily').run();
  await env.DB.prepare('DELETE FROM platform_settings').run();
});

async function rest(
  method: string,
  path: string,
  who: { user: string; device?: string },
  body?: unknown,
) {
  const headers: Record<string, string> = { [DEV_USER_HEADER]: who.user };
  if (who.device) headers[DEV_DEVICE_HEADER] = who.device;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
}

/** This cycle's estimate, in GB of the free tier's 1,000 (920 is economy, below the block). */
async function useGB(gb: number) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, ?, 0, 0)',
  )
    .bind(SPACE_ID, new Date().toISOString().slice(0, 10), gb)
    .run();
}

const PUBLISH = {
  sessionDescription: offer,
  tracks: [{ mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] }],
  preset: 'max',
  maxBitrateKbps: 12_000,
};

async function publishAndAnnounce(roomId: string) {
  const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
  expect(pub.status).toBe(201);
  const { client: helper } = await Client.join(roomId, HELPER.user, {
    client: 'helper',
    deviceId: HELPER.device,
  });
  const started = await helper.request('stream.announce', {
    sfuSessionId: pub.body.sfuSessionId,
    source: { kind: 'screen', label: 'Screen 1' },
    preset: 'game',
    hasAudio: false,
    tracks: [{ name: 'video', kind: 'video', rids: ['f', 'h', 'q'] }],
  });
  if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
  return { pub: pub.body, helper, stream: started.payload.stream };
}

describe('economy mode (brake 3)', () => {
  it('caps a new publish, shows the cap on the stream and starts viewers on the middle layer', async () => {
    const sfu = new FakeSfu().install();
    await useGB(920);
    const roomId = await newRoom({ settings: { maxBitrateKbps: 13_000 } });
    const { pub, stream } = await publishAndAnnounce(roomId);
    expect(pub.qualityCap).toEqual(CAP);
    expect(stream.qualityCap).toEqual(CAP);

    const session = await rest(
      'POST',
      `/rtc/rooms/${roomId}/session`,
      { user: USERS.member2.id },
      {
        sessionDescription: offer,
      },
    );
    const { client } = await Client.join(roomId, USERS.member2.id);
    const grant = await client.request('slot.request', { streamId: stream.streamId });
    if (grant.type !== 'slot.granted') throw new Error(JSON.stringify(grant));
    const sub = await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: USERS.member2.id },
      {
        sessionId: session.body.sessionId,
        slotId: grant.payload.slotId,
        streamId: stream.streamId,
      },
    );
    expect(sub.body.rid).toBe('h');
    expect(
      sfu.of('POST /sessions/:id/tracks/new').at(-1)?.body.tracks[0].simulcast.preferredRid,
    ).toBe('h');
  });

  it('is off below 90 % and when the admin turned it off', async () => {
    new FakeSfu().install();
    await useGB(500);
    const roomId = await newRoom();
    const below = await publishAndAnnounce(roomId);
    expect(below.pub.qualityCap).toBeUndefined();
    expect(below.stream.qualityCap).toBeUndefined();

    await useGB(420);
    await env.DB.prepare(
      "INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('budget', ?, 0)",
    )
      .bind(JSON.stringify({ budget: { kind: 'free' }, mode: 'block', autoEconomy: false }))
      .run();
    const other = await newRoom();
    const res = await rest('POST', `/rtc/rooms/${other}/publish`, HELPER, PUBLISH);
    expect(res.status).toBe(201);
    expect(res.body.qualityCap).toBeUndefined();
  });

  it('caps running streams live at the next meter flush, and lifts the cap again', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { helper, stream } = await publishAndAnnounce(roomId);
    expect(stream.qualityCap).toBeUndefined();
    const { client: web } = await Client.join(roomId, USERS.member2.id);

    await useGB(920);
    await roomStub(roomId).flushUsage();
    expect((await helper.take('stream.updated')).payload.stream.qualityCap).toEqual(CAP);
    expect((await web.take('stream.updated')).payload.stream.qualityCap).toEqual(CAP);

    await env.DB.prepare('DELETE FROM usage_daily').run();
    await roomStub(roomId).flushUsage();
    expect((await helper.take('stream.updated')).payload.stream.qualityCap).toBeUndefined();
  });
});
