// SPDX-License-Identifier: AGPL-3.0-only
import { joinGB, overheads, viewerStreamGB } from '@openlive/usage';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { answer, FakeSfu, offer } from './fake-sfu';
import { Client, elapseMeter, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// The SFU proxy (docs/PROTOCOL.md 11.2) and the stream lifecycle (7.2), against a fake
// Realtime API (test/fake-sfu.ts) with the response shapes seen in early experiments.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

async function rest(
  method: string,
  path: string,
  who: { user: string; device?: string },
  body?: unknown,
): Promise<{ status: number; body: Json; text: string }> {
  const headers: Record<string, string> = { [DEV_USER_HEADER]: who.user };
  if (who.device) headers[DEV_DEVICE_HEADER] = who.device;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const TRACKS = [
  { mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
  { mid: '1', trackName: 'audio', kind: 'audio' },
] as const;
const PUBLISH = { sessionDescription: offer, tracks: TRACKS, preset: 'game', maxBitrateKbps: 9000 };
const HELPER = { user: USERS.member1.id, device: 'd_pc1' };

/** A helper of `who` publishes and announces in `roomId`; returns its socket and the stream. */
async function liveStream(roomId: string, who: { user: string; device: string } = HELPER) {
  const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, who, PUBLISH);
  expect(pub.status).toBe(201);
  const { client: helper } = await Client.join(roomId, who.user, {
    client: 'helper',
    deviceId: who.device,
  });
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
  return { helper, streamId: started.payload.stream.streamId, sfuSessionId: pub.body.sfuSessionId };
}

/** A web viewer with an SFU session and a slot on `streamId`. */
async function viewer(roomId: string, streamId: string, user: string = USERS.member2.id) {
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
  const grant = await client.request('slot.request', { streamId });
  if (grant.type !== 'slot.granted') throw new Error(JSON.stringify(grant));
  return { client, sessionId: session.body.sessionId as string, slotId: grant.payload.slotId };
}

describe('publish', () => {
  it('creates the SFU session and answers the helper offer; the token never leaves', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const res = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sfuSessionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionDescription: { type: 'answer', sdp: expect.any(String) },
      tracks: [
        { mid: '0', trackName: 'video' },
        { mid: '1', trackName: 'audio' },
      ],
      announceWithinMs: 60_000,
    });
    expect(res.text).not.toContain('test-app-token');
    expect(sfu.calls.map((c) => c.op)).toEqual([
      'POST /sessions/new',
      'POST /sessions/:id/tracks/new',
    ]);
    expect(sfu.calls.every((c) => c.authorization === 'Bearer test-app-token')).toBe(true);
    expect(sfu.of('POST /sessions/:id/tracks/new')[0]?.body).toEqual({
      sessionDescription: offer,
      tracks: [
        { location: 'local', mid: '0', trackName: 'video' },
        { location: 'local', mid: '1', trackName: 'audio' },
      ],
    });
    // Remembered for reconciliation per space.
    const row = await env.DB.prepare('SELECT * FROM realtime_sessions WHERE session_id = ?')
      .bind(res.body.sfuSessionId)
      .first();
    expect(row).toMatchObject({ space_id: SPACE_ID, room_id: roomId, kind: 'publish' });
  });

  it('refuses web callers, guests without permission, presets and bitrates above the room', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { maxBitrateKbps: 8000 } });
    const url = `/rtc/rooms/${roomId}/publish`;
    expect(await rest('POST', url, { user: USERS.member1.id }, PUBLISH)).toMatchObject({
      status: 403,
      body: { code: 'forbidden', roomId },
    });
    expect(
      await rest('POST', url, { user: USERS.guest1.id, device: 'd_g' }, PUBLISH),
    ).toMatchObject({ status: 403, body: { code: 'stream_permission_required', roomId } });
    expect(await rest('POST', url, HELPER, { ...PUBLISH, preset: 'native' })).toMatchObject({
      status: 403,
      body: { code: 'preset_not_allowed', preset: 'native' },
    });
    // A 120 fps preset is a valid preset (protocol 1.8), off by default.
    expect(await rest('POST', url, HELPER, { ...PUBLISH, preset: 'max120' })).toMatchObject({
      status: 403,
      body: { code: 'preset_not_allowed', preset: 'max120' },
    });
    expect(await rest('POST', url, HELPER, PUBLISH)).toMatchObject({
      status: 403,
      body: { code: 'bitrate_not_allowed', limit: 8000 },
    });
    expect(
      await rest('POST', url, { user: USERS.outsider.id, device: 'd_o' }, PUBLISH),
    ).toMatchObject({
      status: 403,
      body: { code: 'forbidden', roomId },
    });
  });

  it('counts pending publications against the stream limit, and one stream per device', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { maxStreams: 2 } });
    await liveStream(roomId);
    expect(await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH)).toMatchObject({
      status: 409,
      body: { code: 'helper_busy', deviceId: 'd_pc1' },
    });
    const other = { user: USERS.member2.id, device: 'd_pc2' };
    expect((await rest('POST', `/rtc/rooms/${roomId}/publish`, other, PUBLISH)).status).toBe(201);
    // Not announced yet, but it holds the room's second stream.
    expect(
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/publish`,
        { user: USERS.owner.id, device: 'd_o' },
        PUBLISH,
      ),
    ).toMatchObject({ status: 409, body: { code: 'stream_limit_reached', limit: 2 } });
  });

  it('blocks new streams when the quota brake is on', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      expect(await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH)).toMatchObject({
        status: 403,
        body: { code: 'quota_exhausted' },
      });
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });

  it('checks the three SFU error levels and never forwards the SFU text', async () => {
    const roomId = await newRoom();
    const cases: ((op: string) => Response | null)[] = [
      (op) =>
        op === 'POST /sessions/new' ? Response.json({ errorCode: 'boom' }, { status: 500 }) : null,
      (op) =>
        op === 'POST /sessions/new'
          ? Response.json({ errorCode: 'session_error', errorDescription: 'secret detail' })
          : null,
      (op) =>
        op === 'POST /sessions/:id/tracks/new'
          ? Response.json({
              tracks: [{ trackName: 'video', errorCode: 'bad_track', errorDescription: 'nope' }],
            })
          : null,
    ];
    for (const override of cases) {
      vi.restoreAllMocks();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      new FakeSfu({ override: (c) => override(c.op) }).install();
      const res = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
      expect(res).toMatchObject({ status: 502, body: { code: 'sfu_error' } });
      expect(res.text).not.toContain('detail');
    }
  });

  it("takes the platform admin's ceilings: a 120 fps preset once allowed", async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const url = `/rtc/rooms/${roomId}/publish`;
    const max120 = { ...PUBLISH, preset: 'max120', maxBitrateKbps: 24_628 };
    // The default 13 Mbps ceiling and 60 fps presets refuse it.
    expect(await rest('POST', url, HELPER, max120)).toMatchObject({
      status: 403,
      body: { code: 'preset_not_allowed', preset: 'max120' },
    });
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('room_limits', ?, 0)`,
    )
      .bind(
        JSON.stringify({
          maxStreams: 5,
          maxViewersPerStream: 6,
          maxBitrateKbps: 25_000,
          allowedPresets: ['text', 'game', 'max', 'game120', 'max120'],
          maxResolution: '1440p',
          maxFps: 120,
        }),
      )
      .run();
    try {
      expect(await rest('POST', url, HELPER, max120)).toMatchObject({
        status: 201,
        body: { sessionDescription: { type: 'answer' } },
      });
    } finally {
      await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'room_limits'").run();
    }
  });

  it('renegotiates and unpublishes the own publication only', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { sfuSessionId, streamId } = await liveStream(roomId);
    const other = { user: USERS.member1.id, device: 'd_other' };
    const reneg = `/rtc/rooms/${roomId}/publish/renegotiate`;
    expect(
      await rest('PUT', reneg, other, { sfuSessionId, sessionDescription: offer }),
    ).toMatchObject({
      status: 404,
      body: { code: 'sfu_session_not_found', sessionId: sfuSessionId },
    });
    expect(
      await rest('PUT', reneg, HELPER, { sfuSessionId, sessionDescription: offer }),
    ).toMatchObject({ status: 200, body: { sessionDescription: { type: 'answer' } } });
    expect(
      (await rest('POST', `/rtc/rooms/${roomId}/unpublish`, HELPER, { sfuSessionId })).status,
    ).toBe(204);
    expect((await web.take('stream.ended')).payload).toEqual({
      streamId,
      reason: 'ended_by_streamer',
    });
    expect(sfu.of('PUT /sessions/:id/tracks/close').at(-1)?.body).toEqual({
      tracks: [{ mid: '0' }, { mid: '1' }],
      force: true,
    });
    // Idempotent.
    expect(
      (await rest('POST', `/rtc/rooms/${roomId}/unpublish`, HELPER, { sfuSessionId })).status,
    ).toBe(204);
  });

  it('closes a publication that is never announced', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      state.storage.sql.exec('UPDATE publications SET announce_by = 1');
    });
    expect(await runDurableObjectAlarm(roomStub(roomId))).toBe(true);
    const close = sfu.of('PUT /sessions/:id/tracks/close');
    expect(close.map((c) => c.sessionId)).toEqual([pub.body.sfuSessionId]);
    // The slot it held for the stream limit is free again.
    expect((await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH)).status).toBe(201);
  });
});

describe('stream.announce', () => {
  it('announces the stream to everyone, without SFU details', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { streamId, sfuSessionId } = await liveStream(roomId);
    const started = await web.take('stream.started');
    expect(started.payload.stream).toEqual({
      streamId,
      userId: USERS.member1.id,
      deviceId: 'd_pc1',
      source: { kind: 'screen', label: 'Screen 1' },
      preset: 'game',
      hasAudio: true,
      paused: false,
      startedAt: expect.any(Number),
      viewerLimit: 6,
      viewerCount: 0,
    });
    expect(JSON.stringify(started)).not.toContain(sfuSessionId);
  });

  it('keeps the layers the helper encodes (1.19) and replaces them with a new preset', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
    const { client: helper } = await Client.join(roomId, HELPER.user, {
      client: 'helper',
      deviceId: HELPER.device,
    });
    // A 3440x1440 monitor: every layer keeps the source's aspect ratio.
    const layers = [
      { rid: 'f', width: 2576, height: 1080, fps: 60, kbps: 8000 },
      { rid: 'h', width: 1728, height: 720, fps: 60, kbps: 3500 },
      { rid: 'q', width: 1152, height: 480, fps: 30, kbps: 1000 },
    ];
    const announce = {
      sfuSessionId: pub.body.sfuSessionId as string,
      source: { kind: 'screen' as const, label: 'DP-2' },
      preset: 'game' as const,
      hasAudio: true,
      tracks: [
        { name: 'video', kind: 'video' as const, rids: ['f', 'h', 'q'] },
        { name: 'audio', kind: 'audio' as const },
      ],
    };
    // One layer per rid, in the track's order.
    expect(
      await helper.request('stream.announce', { ...announce, layers: layers.slice(1) }),
    ).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message', path: '/payload/layers' },
    });
    const started = await helper.request('stream.announce', { ...announce, layers });
    if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
    expect(started.payload.stream.layers).toEqual(layers);
    expect((await web.take('stream.started')).payload.stream.layers).toEqual(layers);
    const streamId = started.payload.stream.streamId;

    // A pause keeps them; a new preset brings its own, or none from a helper before 1.19.
    await helper.request('stream.update', { streamId, paused: true });
    expect((await web.take('stream.updated')).payload.stream.layers).toEqual(layers);
    const text = [{ rid: 'f', width: 2576, height: 1080, fps: 30, kbps: 6000 }, ...layers.slice(1)];
    await helper.request('stream.update', { streamId, preset: 'text', layers: text });
    expect((await web.take('stream.updated')).payload.stream).toMatchObject({
      preset: 'text',
      layers: text,
    });
    await helper.request('stream.update', { streamId, preset: 'game' });
    expect((await web.take('stream.updated')).payload.stream).not.toHaveProperty('layers');
  });

  it('refuses web clients, foreign sessions and tracks that were not published', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, PUBLISH);
    const announce = (tracks: { name: string; kind: 'video' | 'audio'; rids?: string[] }[]) => ({
      sfuSessionId: pub.body.sfuSessionId as string,
      source: { kind: 'window' as const, label: 'Editor' },
      preset: 'text' as const,
      hasAudio: false,
      tracks,
    });
    const { client: web } = await Client.join(roomId, USERS.member1.id);
    expect(
      await web.request('stream.announce', announce([{ name: 'video', kind: 'video' }])),
    ).toMatchObject({ type: 'error', payload: { code: 'forbidden' } });
    const { client: otherDevice } = await Client.join(roomId, USERS.member1.id, {
      client: 'helper',
      deviceId: 'd_other',
    });
    expect(
      await otherDevice.request('stream.announce', announce([{ name: 'video', kind: 'video' }])),
    ).toMatchObject({ type: 'error', payload: { code: 'sfu_session_not_found' } });
    const { client: helper } = await Client.join(roomId, USERS.member1.id, {
      client: 'helper',
      deviceId: 'd_pc1',
    });
    expect(
      await helper.request('stream.announce', announce([{ name: 'audio', kind: 'video' }])),
    ).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message', path: '/payload/tracks/0' },
    });
    expect(
      await helper.request(
        'stream.announce',
        announce([{ name: 'video', kind: 'video', rids: ['q'] }]),
      ),
    ).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message', path: '/payload/tracks/0' },
    });
    expect(
      (await helper.request('stream.announce', announce([{ name: 'video', kind: 'video' }]))).type,
    ).toBe('stream.started');
  });
});

describe('viewer session and subscribe', () => {
  it('pre-connects: TURN in parallel with sessions/new, port 53 removed, space id tagged', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const res = await rest(
      'POST',
      `/rtc/rooms/${roomId}/session`,
      { user: USERS.member2.id },
      {
        sessionDescription: offer,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionDescription: { type: 'answer', sdp: expect.any(String) },
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'turn-user',
          credential: 'turn-credential',
        },
      ],
    });
    expect(res.text).not.toContain('test-turn-token');
    expect(sfu.turnCalls).toEqual([
      {
        body: { ttl: 14_400, customIdentifier: SPACE_ID },
        authorization: 'Bearer test-turn-token',
      },
    ]);
    expect(sfu.of('POST /sessions/new')[0]?.body).toEqual({ sessionDescription: offer });
  });

  it('needs a slot, then pulls video (simulcast policy) and audio onto the viewer session', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId, sfuSessionId } = await liveStream(roomId);
    const { sessionId, slotId } = await viewer(roomId, streamId);
    const url = `/rtc/rooms/${roomId}/subscribe`;
    const who = { user: USERS.member2.id };

    expect(await rest('POST', url, who, { sessionId, slotId: 'sl_nope', streamId })).toMatchObject({
      status: 404,
      body: { code: 'slot_not_found', slotId: 'sl_nope' },
    });
    // Someone else's slot or session is not the caller's.
    expect(
      await rest('POST', url, { user: USERS.admin.id }, { sessionId, slotId, streamId }),
    ).toMatchObject({ status: 404, body: { code: 'sfu_session_not_found', sessionId } });
    expect(await rest('POST', url, who, { sessionId, slotId, streamId, rid: 'x' })).toMatchObject({
      status: 400,
      body: { code: 'invalid_message', path: '/rid' },
    });

    const res = await rest('POST', url, who, { sessionId, slotId, streamId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      streamId,
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: expect.any(String) },
      tracks: [
        { mid: '0', kind: 'video' },
        { mid: '1', kind: 'audio' },
      ],
      rid: 'f',
      codec: 'h264',
    });
    // The publisher's session and track names stay on the server.
    expect(res.text).not.toContain(sfuSessionId);
    const pull = sfu.of('POST /sessions/:id/tracks/new').at(-1);
    expect(pull?.sessionId).toBe(sessionId);
    expect(pull?.body).toEqual({
      tracks: [
        {
          location: 'remote',
          sessionId: sfuSessionId,
          trackName: 'video',
          simulcast: {
            preferredRid: 'f',
            priorityOrdering: 'none',
            ridNotAvailable: 'asciibetical',
          },
        },
        { location: 'remote', sessionId: sfuSessionId, trackName: 'audio' },
      ],
    });

    // Answer, switch layer, unsubscribe.
    expect(
      await rest('PUT', `/rtc/rooms/${roomId}/renegotiate`, who, {
        sessionId,
        sessionDescription: answer,
      }),
    ).toEqual({ status: 200, body: {}, text: '{}' });
    expect(
      (await rest('PUT', `/rtc/rooms/${roomId}/layer`, who, { sessionId, streamId, rid: 'q' }))
        .status,
    ).toBe(204);
    expect(sfu.of('PUT /sessions/:id/tracks/update').at(-1)?.body).toEqual({
      tracks: [
        {
          location: 'remote',
          sessionId: sfuSessionId,
          trackName: 'video',
          mid: '0',
          simulcast: {
            preferredRid: 'q',
            priorityOrdering: 'none',
            ridNotAvailable: 'asciibetical',
          },
        },
      ],
    });
    expect(
      (await rest('PUT', `/rtc/rooms/${roomId}/layer`, who, { sessionId, streamId, rid: 'z' }))
        .body,
    ).toEqual({ code: 'invalid_message', path: '/rid' });
    expect(
      (await rest('POST', `/rtc/rooms/${roomId}/unsubscribe`, who, { sessionId, streamId })).status,
    ).toBe(204);
    expect(sfu.of('PUT /sessions/:id/tracks/close').at(-1)).toMatchObject({
      sessionId,
      body: { tracks: [{ mid: '0' }, { mid: '1' }], force: true },
    });
    expect(
      (await rest('PUT', `/rtc/rooms/${roomId}/layer`, who, { sessionId, streamId, rid: 'q' }))
        .body,
    ).toEqual({ code: 'stream_not_found', streamId });
  });

  it('starts on the requested layer', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const { sessionId, slotId } = await viewer(roomId, streamId);
    const res = await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: USERS.member2.id },
      {
        sessionId,
        slotId,
        streamId,
        rid: 'h',
      },
    );
    expect(res.body.rid).toBe('h');
    expect(
      sfu.of('POST /sessions/:id/tracks/new').at(-1)?.body.tracks[0].simulcast.preferredRid,
    ).toBe('h');
  });

  it('closes the pulled tracks when the slot goes, and on leave', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const who = { user: USERS.member2.id };
    const { client, sessionId, slotId } = await viewer(roomId, streamId);
    await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who, { sessionId, slotId, streamId });
    expect((await client.request('slot.release', { slotId })).type).toBe('slot.released');
    await client.drain('viewers');
    expect((await sfu.until('PUT /sessions/:id/tracks/close', 1)).map((c) => c.sessionId)).toEqual([
      sessionId,
    ]);

    // Leave (sendBeacon sends text/plain) closes what is pulled and forgets the session.
    const grant = await client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected a slot');
    await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who, {
      sessionId,
      slotId: grant.payload.slotId,
      streamId,
    });
    const beacon = await exports.default.fetch('http://localhost/api/rtc/leave', {
      method: 'POST',
      headers: { [DEV_USER_HEADER]: who.user, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ roomId, sessionId }),
    });
    expect(beacon.status).toBe(204);
    expect(await sfu.until('PUT /sessions/:id/tracks/close', 2)).toHaveLength(2);
    expect(
      (
        await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who, {
          sessionId,
          slotId: grant.payload.slotId,
          streamId,
        })
      ).body,
    ).toEqual({ code: 'sfu_session_not_found', sessionId });
  });

  it('serializes the calls on one SFU session', async () => {
    const sfu = new FakeSfu({ delayMs: 30 }).install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const who = { user: USERS.member2.id };
    const { sessionId, slotId } = await viewer(roomId, streamId);
    await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who, { sessionId, slotId, streamId });
    await Promise.all(
      ['q', 'h', 'f', 'q'].map((rid) =>
        rest('PUT', `/rtc/rooms/${roomId}/layer`, who, { sessionId, streamId, rid }),
      ),
    );
    const updates = sfu.of('PUT /sessions/:id/tracks/update');
    expect(updates).toHaveLength(4);
    for (let i = 1; i < updates.length; i++) {
      const prev = updates[i - 1];
      const cur = updates[i];
      expect(cur && prev && cur.startedAt >= prev.endedAt).toBe(true);
    }
  });
});

describe('stream lifecycle', () => {
  it('updates, limits and ends a stream', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { helper, streamId } = await liveStream(roomId);
    await web.take('stream.started');

    expect(
      (
        await helper.request('stream.update', {
          streamId,
          paused: true,
          pauseReason: 'privacy_curtain',
        })
      ).type,
    ).toBe('ack');
    expect((await web.take('stream.updated')).payload.stream).toMatchObject({
      paused: true,
      pauseReason: 'privacy_curtain',
    });
    await helper.request('stream.update', { streamId, paused: false });
    expect((await web.take('stream.updated')).payload.stream).not.toHaveProperty('pauseReason');
    expect(await helper.request('stream.update', { streamId, preset: 'native' })).toMatchObject({
      type: 'error',
      payload: { code: 'preset_not_allowed', preset: 'native' },
    });

    expect(await helper.request('stream.setViewerLimit', { streamId, limit: 7 })).toMatchObject({
      type: 'error',
      payload: { code: 'viewer_limit_too_high', streamId, limit: 6 },
    });
    expect((await web.request('stream.setViewerLimit', { streamId, limit: 2 })).type).toBe('error');
    expect((await helper.request('stream.setViewerLimit', { streamId, limit: 2 })).type).toBe(
      'ack',
    );
    expect((await web.take('stream.updated')).payload.stream.viewerLimit).toBe(2);

    // A viewer is pulling when the helper ends the stream: slots go, tracks close.
    const { sessionId, slotId } = await viewer(roomId, streamId, USERS.admin.id);
    await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: USERS.admin.id },
      {
        sessionId,
        slotId,
        streamId,
      },
    );
    expect((await helper.request('stream.end', { streamId })).type).toBe('ack');
    expect((await web.take('stream.ended')).payload).toEqual({
      streamId,
      reason: 'ended_by_streamer',
    });
    const closed = (await sfu.until('PUT /sessions/:id/tracks/close', 2)).map((c) => c.sessionId);
    expect(closed).toContain(sessionId);
    expect(await web.request('slot.request', { streamId })).toMatchObject({
      type: 'error',
      payload: { code: 'stream_not_found' },
    });
  });

  it('lets moderators terminate under the removal rule', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: admin } = await Client.join(roomId, USERS.admin.id);
    const { client: member } = await Client.join(roomId, USERS.member2.id);
    const owner = await liveStream(roomId, { user: USERS.owner.id, device: 'd_owner' });
    const m1 = await liveStream(roomId);
    expect(await admin.request('stream.terminate', { streamId: owner.streamId })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    expect(await member.request('stream.terminate', { streamId: m1.streamId })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    expect((await admin.request('stream.terminate', { streamId: m1.streamId })).type).toBe('ack');
    expect((await m1.helper.take('stream.stop')).payload).toEqual({
      streamId: m1.streamId,
      reason: 'ended_by_moderator',
    });
    expect(
      (await member.take('stream.ended', (m) => m.payload.streamId === m1.streamId)).payload,
    ).toEqual({ streamId: m1.streamId, reason: 'ended_by_moderator' });
  });

  it('keeps a stream for 15 s after the helper drops, and ends it after', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const first = await liveStream(roomId);
    first.helper.close();
    await first.helper.closed;
    // Back within the grace period: the stream survives.
    const { client: again } = await Client.join(roomId, USERS.member1.id, {
      client: 'helper',
      deviceId: 'd_pc1',
    });
    const grace = () =>
      runInDurableObject(
        roomStub(roomId),
        async (_, state) =>
          state.storage.sql
            .exec<{ g: number | null }>('SELECT grace_until AS g FROM stream_sfu')
            .one().g,
      );
    expect(await grace()).toBeNull();
    again.close();
    await again.closed;
    await web.drain('member.left');
    expect(await grace()).toBeGreaterThan(Date.now());
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      state.storage.sql.exec('UPDATE stream_sfu SET grace_until = 1');
    });
    await runDurableObjectAlarm(roomStub(roomId));
    expect((await web.take('stream.ended')).payload).toEqual({
      streamId: first.streamId,
      reason: 'helper_disconnected',
    });
  });

  it('ends the streams of a user whose stream permission is revoked', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { helper, streamId } = await liveStream(roomId);
    await roomStub(roomId).permissionsChanged(USERS.member1.id, {
      role: 'member',
      permissions: { canStream: false, canModerate: false },
    });
    expect((await helper.take('stream.stop')).payload).toEqual({
      streamId,
      reason: 'permission_revoked',
    });
    expect((await web.take('stream.ended')).payload.reason).toBe('permission_revoked');
  });

  it('ends streams when the room closes', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { streamId, sfuSessionId } = await liveStream(roomId);
    await roomStub(roomId).closeRoom('ended_by_owner');
    expect((await web.take('stream.ended')).payload).toEqual({ streamId, reason: 'room_closed' });
    expect((await web.take('room.closed')).payload.reason).toBe('ended_by_owner');
    expect(sfu.of('PUT /sessions/:id/tracks/close').map((c) => c.sessionId)).toContain(
      sfuSessionId,
    );
  });
});

describe('usage meter', () => {
  /** Moves the meter's last accrual `seconds` into the past, as if that much time went by. */
  const elapse = (roomId: string, seconds: number) => elapseMeter(roomId, seconds * 1000);
  const usage = async () =>
    env.DB.prepare(
      'SELECT egress_gb_est AS gb, viewer_minutes AS vm, stream_minutes AS sm FROM usage_daily WHERE space_id = ?',
    )
      .bind(SPACE_ID)
      .first<{ gb: number; vm: number; sm: number }>();

  it('accrues viewer-seconds per layer and joins while slots are held, and flushes to D1', async () => {
    new FakeSfu().install();
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const a = await viewer(roomId, streamId, USERS.member2.id);
    const b = await viewer(roomId, streamId, USERS.admin.id);
    const who = (user: string) => ({ user });
    // a watches the top layer (9 Mbps), b the low one (1.2 Mbps): two joins, both at the top
    // layer's rate (the SFU starts every pull on the top layer).
    await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who(USERS.member2.id), {
      sessionId: a.sessionId,
      slotId: a.slotId,
      streamId,
    });
    await rest('POST', `/rtc/rooms/${roomId}/subscribe`, who(USERS.admin.id), {
      sessionId: b.sessionId,
      slotId: b.slotId,
      streamId,
      rid: 'q',
    });
    // The meter's alarm is armed while the stream is live.
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await elapse(roomId, 60);
    await roomStub(roomId).flushUsage();
    const o = overheads(true);
    const expected = viewerStreamGB(9 + 1.2, 60, o) + joinGB(9, o) + joinGB(9, o);
    const row = await usage();
    expect(row?.vm).toBe(2);
    expect(row?.sm).toBe(1);
    // At least the 60 s shifted, plus the real seconds the test took (a few at most under load).
    expect(row?.gb).toBeGreaterThanOrEqual(expected);
    expect(row?.gb).toBeLessThan(expected + viewerStreamGB(10.2, 5, o));

    // Ending the stream flushes what accrued since.
    await elapse(roomId, 30);
    const before = row?.gb ?? 0;
    await rest('POST', `/rtc/rooms/${roomId}/unpublish`, HELPER, {
      sfuSessionId: await runInDurableObject(
        roomStub(roomId),
        async (_, state) =>
          state.storage.sql
            .exec<{ id: string }>('SELECT sfu_session_id AS id FROM publications')
            .one().id,
      ),
    });
    const after = (await usage())?.gb ?? 0;
    expect(after).toBeGreaterThanOrEqual(before + viewerStreamGB(10.2, 30, o));
    expect(after).toBeLessThan(before + viewerStreamGB(10.2, 35, o));
  });

  it('ends running streams after the grace period once the quota blocks', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    const { helper, streamId } = await liveStream(roomId);
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    await env.DB.prepare(
      'INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      // First flush that sees the block starts the grace period; the stream keeps going.
      await roomStub(roomId).flushUsage();
      expect(await web.request('slot.request', { streamId })).toMatchObject({
        type: 'slot.granted',
      });
      // Grace over.
      await runInDurableObject(roomStub(roomId), async (_, state) => {
        state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'quota_blocked_at'");
      });
      await roomStub(roomId).flushUsage();
      expect((await helper.take('stream.stop')).payload).toEqual({
        streamId,
        reason: 'quota_exhausted',
      });
      expect((await web.take('stream.ended')).payload.reason).toBe('quota_exhausted');
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });
});

describe('AV1', () => {
  const TRACKS_AV1 = [
    { mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
    { mid: '1', trackName: 'video-av1', kind: 'video', codec: 'av1' },
    { mid: '2', trackName: 'audio', kind: 'audio' },
  ] as const;
  /** The platform admin allows AV1 (all presets on Automatic but `h264Only`). */
  const allowAv1 = (presetCodecs: Record<string, string> = {}) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO platform_settings (key, value_json, updated_at) VALUES ('room_limits', ?, 0)`,
    )
      .bind(JSON.stringify({ allowAv1: true, presetCodecs }))
      .run();
  const disallow = () =>
    env.DB.prepare("DELETE FROM platform_settings WHERE key = 'room_limits'").run();
  afterEach(disallow);

  async function liveAv1(roomId: string) {
    const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, HELPER, {
      ...PUBLISH,
      tracks: TRACKS_AV1,
    });
    expect(pub.status).toBe(201);
    const { client: helper } = await Client.join(roomId, HELPER.user, {
      client: 'helper',
      deviceId: HELPER.device,
    });
    const started = await helper.request('stream.announce', {
      sfuSessionId: pub.body.sfuSessionId,
      source: { kind: 'screen', label: 'Screen 1' },
      preset: 'game',
      hasAudio: true,
      tracks: [
        { name: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
        { name: 'video-av1', kind: 'video', codec: 'av1' },
        { name: 'audio', kind: 'audio' },
      ],
    });
    if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
    return started.payload.stream.streamId as string;
  }
  const pulledNames = (sfu: FakeSfu) =>
    (
      sfu.of('POST /sessions/:id/tracks/new').at(-1)?.body.tracks as {
        trackName: string;
        simulcast?: { preferredRid: string };
      }[]
    ).map((t) => `${t.trackName}${t.simulcast ? `@${t.simulcast.preferredRid}` : ''}`);

  it('publishes one video track per codec, an H.264 one among them', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const url = `/rtc/rooms/${roomId}/publish`;
    const bad = [
      [TRACKS_AV1[1], TRACKS_AV1[2]],
      [TRACKS_AV1[0], { ...TRACKS_AV1[0], trackName: 'video2' }, TRACKS_AV1[2]],
      [TRACKS_AV1[0], { ...TRACKS_AV1[2], codec: 'av1' }],
    ];
    for (const tracks of bad) {
      expect(await rest('POST', url, HELPER, { ...PUBLISH, tracks })).toMatchObject({
        status: 400,
        body: { code: 'invalid_message', path: '/tracks' },
      });
    }
  });

  it('pulls the AV1 track for a viewer that asks on the top layer, H.264 for the rest', async () => {
    await allowAv1();
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const streamId = await liveAv1(roomId);
    const a = await viewer(roomId, streamId, USERS.member2.id);
    const who = { user: USERS.member2.id };
    const subscribe = (body: Record<string, unknown>) =>
      rest('POST', `/rtc/rooms/${roomId}/subscribe`, who, {
        sessionId: a.sessionId,
        slotId: a.slotId,
        streamId,
        ...body,
      });

    const av1 = await subscribe({ codec: 'av1' });
    expect(av1.body).toMatchObject({ codec: 'av1', rid: 'f' });
    // The AV1 track is the top layer alone: no simulcast preference.
    expect(pulledNames(sfu)).toEqual(['video-av1', 'audio']);
    // Staying on the top layer is a no-op; another layer is a new pull, not a tracks/update.
    const layer = (rid: string) =>
      rest('PUT', `/rtc/rooms/${roomId}/layer`, who, { sessionId: a.sessionId, streamId, rid });
    expect((await layer('f')).status).toBe(204);
    expect(await layer('h')).toMatchObject({
      status: 409,
      body: { code: 'invalid_message', path: '/rid' },
    });
    expect(sfu.of('PUT /sessions/:id/tracks/update')).toEqual([]);

    // Asking for AV1 on a lower layer (or in economy mode) gets the H.264 track.
    expect((await subscribe({ codec: 'av1', rid: 'h' })).body).toMatchObject({
      codec: 'h264',
      rid: 'h',
    });
    expect(pulledNames(sfu)).toEqual(['video@h', 'audio']);
    // Without a codec (a browser without AV1, or an older client): H.264.
    expect((await subscribe({})).body).toMatchObject({ codec: 'h264', rid: 'f' });
    expect(pulledNames(sfu)).toEqual(['video@f', 'audio']);
  });

  it('pulls H.264 where the room does not allow AV1 for the preset', async () => {
    await allowAv1({ game: 'h264' });
    new FakeSfu().install();
    const roomId = await newRoom();
    const streamId = await liveAv1(roomId);
    const a = await viewer(roomId, streamId, USERS.member2.id);
    const res = await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: USERS.member2.id },
      {
        sessionId: a.sessionId,
        slotId: a.slotId,
        streamId,
        codec: 'av1',
      },
    );
    expect(res.body.codec).toBe('h264');
    await disallow();
    const off = await rest(
      'POST',
      `/rtc/rooms/${roomId}/subscribe`,
      { user: USERS.member2.id },
      {
        sessionId: a.sessionId,
        slotId: a.slotId,
        streamId,
        codec: 'av1',
      },
    );
    expect(off.body.codec).toBe('h264');
  });

  it.each([
    ['saving data (the default)', {}, 0.65],
    ['saving data, stored as `auto` from before AV1 modes', { game: 'auto' }, 0.65],
    ['saving data', { game: 'av1Save' }, 0.65],
    ['for quality', { game: 'av1Quality' }, 1],
  ])(
    'meters an AV1 viewer %s at its share of the top layer, its join included',
    async (_, codecs, share) => {
      await allowAv1(codecs);
      new FakeSfu().install();
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
      const roomId = await newRoom();
      const streamId = await liveAv1(roomId);
      const a = await viewer(roomId, streamId, USERS.member2.id);
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/subscribe`,
        { user: USERS.member2.id },
        {
          sessionId: a.sessionId,
          slotId: a.slotId,
          streamId,
          codec: 'av1',
        },
      );
      await elapseMeter(roomId, 60_000);
      await roomStub(roomId).flushUsage();
      const o = overheads(true);
      // 9 Mbps top layer (the publish's maxBitrateKbps) × the mode's share.
      const expected = viewerStreamGB(9 * share, 60, o) + joinGB(9 * share, o);
      const row = await env.DB.prepare(
        'SELECT egress_gb_est AS gb FROM usage_daily WHERE space_id = ?',
      )
        .bind(SPACE_ID)
        .first<{ gb: number }>();
      expect(row?.gb).toBeGreaterThanOrEqual(expected);
      expect(row?.gb).toBeLessThan(expected + viewerStreamGB(9 * share, 5, o));
    },
  );
});
