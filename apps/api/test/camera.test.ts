// SPDX-License-Identifier: AGPL-3.0-only
import { CAMERA_LAYERS, overheads, viewerStreamGB, joinGB } from '@openlive/usage';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { FakeSfu, offer } from './fake-sfu';
import { Client, elapseMeter, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { checkLimits, roomSettingsPatch, spaceSettingsPatch } from '../src/api/settings';
import { roomSettings } from '../src/room/access';
import { effectiveSettings } from '../src/room/settings';
import { mediaKindOfMid, sendRidsOfMid } from '../src/rtc/sdp';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// Cameras in the voice channel (docs/PROTOCOL.md 7.7): the camera
// routes of the SFU proxy (11.2) against the fake Realtime API (video only, two layers, limits,
// the quota brake), the room's camera state and moderation, and the usage meter per layer.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const CAMERA = { stream: true, voice: true, camera: true, text: true };
const NO_CAMERA = { stream: true, voice: true, camera: false, text: true };

const cameraRoom = (settings: Record<string, unknown> = {}) =>
  newRoom({ settings: { capabilities: CAMERA, ...settings } });

/** An offer with a data channel (mid 0), a microphone (mid 1) and a simulcast camera (mid 2). */
const sdp = (rids: string[] = ['h', 'l']) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=mid:0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    'a=sendonly',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=mid:2',
    'a=sendonly',
    ...rids.map((r) => `a=rid:${r} send`),
    ...(rids.length > 0 ? [`a=simulcast:send ${rids.join(';')}`] : []),
    '',
  ].join('\r\n');
const CAMERA_OFFER = { type: 'offer' as const, sdp: sdp() };

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

async function session(roomId: string, user: string): Promise<string> {
  const res = await rest(
    'POST',
    `/rtc/rooms/${roomId}/session`,
    { user },
    { sessionDescription: offer },
  );
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

/** A web tab of `user` in the room, with its viewer session, joined to voice. */
async function inVoice(roomId: string, user: string) {
  const sessionId = await session(roomId, user);
  const { client, welcome } = await Client.join(roomId, user);
  const joined = await client.request('voice.join', {});
  expect(joined.type).toBe('voice.joined');
  await client.take('voice.tracks');
  return { client, welcome, sessionId };
}

const publishCamera = (
  roomId: string,
  user: string,
  sessionId: string,
  sessionDescription: { type: 'offer'; sdp: string } = CAMERA_OFFER,
  mid = '2',
) =>
  rest(
    'POST',
    `/rtc/rooms/${roomId}/camera/publish`,
    { user },
    { sessionId, sessionDescription, mid },
  );

const subscribeCameras = (
  roomId: string,
  user: string,
  sessionId: string,
  trackIds: string[],
  rid?: string,
) =>
  rest(
    'POST',
    `/rtc/rooms/${roomId}/camera/subscribe`,
    { user },
    { sessionId, trackIds, ...(rid ? { rid } : {}) },
  );

async function changeSettings(roomId: string, settings: Record<string, unknown>) {
  await env.DB.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?')
    .bind(JSON.stringify(settings), roomId)
    .run();
  const effective = await roomSettings(env.DB, roomId);
  if (!effective) throw new Error('no settings');
  await roomStub(roomId).settingsChanged(effective);
}

describe('sdp', () => {
  it('reads the simulcast layers of a mid, highest first', () => {
    expect(mediaKindOfMid(CAMERA_OFFER.sdp, '2')).toBe('video');
    expect(sendRidsOfMid(CAMERA_OFFER.sdp, '2')).toEqual(['h', 'l']);
    expect(sendRidsOfMid(CAMERA_OFFER.sdp, '1')).toEqual([]);
    expect(sendRidsOfMid(CAMERA_OFFER.sdp, '9')).toBeNull();
    // A paused layer and alternatives; without a=simulcast, the a=rid lines in order.
    expect(sendRidsOfMid('v=0\nm=video 9 X 96\na=mid:v\na=simulcast:send ~h;l,x\n', 'v')).toEqual([
      'h',
      'l',
    ]);
    expect(
      sendRidsOfMid('v=0\nm=video 9 X 96\na=mid:v\na=rid:q send\na=rid:z recv\n', 'v'),
    ).toEqual(['q']);
  });
});

describe('camera settings', () => {
  it('defaults to 6 cameras, lowered level by level; guests only where the room says so', () => {
    expect(effectiveSettings(null, '{}')).toMatchObject({
      maxCameras: 6,
      guestsCanUseCamera: false,
    });
    expect(
      effectiveSettings(
        JSON.stringify({ maxCameras: 4 }),
        JSON.stringify({ maxCameras: 9, guestsCanUseCamera: true }),
      ),
    ).toMatchObject({ maxCameras: 4, guestsCanUseCamera: true });
    expect(spaceSettingsPatch.safeParse({ guestsCanUseCamera: true }).success).toBe(false);
    expect(roomSettingsPatch.safeParse({ guestsCanUseCamera: true, maxCameras: 2 }).success).toBe(
      true,
    );
    const ceiling = effectiveSettings(JSON.stringify({ maxCameras: 3 }), null);
    expect(() => checkLimits({ maxCameras: 4 }, ceiling, '/settings')).toThrow(
      expect.objectContaining({
        code: 'setting_above_ceiling',
        params: { path: '/settings/maxCameras', limit: 3 },
      }),
    );
  });

  it('tells each connection whether it may use a camera', async () => {
    new FakeSfu().install();
    const roomId = await cameraRoom();
    const { welcome: member } = await Client.join(roomId, USERS.member1.id);
    const { welcome: guest } = await Client.join(roomId, USERS.guest1.id);
    expect(member.you.permissions.canUseCamera).toBe(true);
    expect(guest.you.permissions.canUseCamera).toBe(false);
    const other = await newRoom({ settings: { capabilities: NO_CAMERA } });
    const { welcome } = await Client.join(other, USERS.member1.id);
    expect(welcome.you.permissions.canUseCamera).toBe(false);
  });
});

describe('camera routes of the SFU proxy', () => {
  it('publishes the camera: video only, two layers at most, in voice, own session', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await cameraRoom();
    const viewer = await inVoice(roomId, USERS.member2.id);
    const { client: watcher } = await Client.join(roomId, USERS.owner.id);
    const sessionId = await session(roomId, USERS.member1.id);
    // Not in voice yet.
    expect(await publishCamera(roomId, USERS.member1.id, sessionId)).toMatchObject({
      status: 409,
      body: { code: 'voice_not_joined' },
    });
    const { client } = await Client.join(roomId, USERS.member1.id);
    await client.request('voice.join', {});
    // Someone else's session.
    expect(await publishCamera(roomId, USERS.member1.id, viewer.sessionId)).toMatchObject({
      status: 404,
      body: { code: 'sfu_session_not_found' },
    });
    // The microphone is not a camera: audio goes through voice/publish.
    expect(
      await publishCamera(roomId, USERS.member1.id, sessionId, CAMERA_OFFER, '1'),
    ).toMatchObject({ status: 400, body: { code: 'invalid_message', path: '/mid' } });
    // Three layers would cost more than planned.
    expect(
      await publishCamera(roomId, USERS.member1.id, sessionId, {
        type: 'offer',
        sdp: sdp(['f', 'h', 'l']),
      }),
    ).toMatchObject({ status: 400, body: { code: 'invalid_message', path: '/mid' } });
    // A helper never publishes a camera.
    expect(
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/camera/publish`,
        { user: USERS.member1.id, device: 'd_pc1' },
        { sessionId, sessionDescription: CAMERA_OFFER, mid: '2' },
      ),
    ).toMatchObject({ status: 403, body: { code: 'forbidden' } });

    const res = await publishCamera(roomId, USERS.member1.id, sessionId);
    expect(res).toMatchObject({
      status: 201,
      body: {
        trackId: expect.stringMatching(/^ct_/),
        mid: '2',
        rids: ['h', 'l'],
        sessionDescription: { type: 'answer' },
      },
    });
    const call = sfu.of('POST /sessions/:id/tracks/new').at(-1);
    expect(call?.body).toEqual({
      sessionDescription: CAMERA_OFFER,
      tracks: [{ location: 'local', mid: '2', trackName: res.body.trackId }],
    });
    // Everyone sees the camera on; the others in voice get it in voice.tracks.
    expect((await watcher.take('voice.updated')).payload.participant).toMatchObject({
      userId: USERS.member1.id,
      camera: true,
    });
    expect((await viewer.client.take('voice.tracks')).payload).toEqual({
      tracks: [],
      cameras: [{ trackId: res.body.trackId, userId: USERS.member1.id, rids: ['h', 'l'] }],
    });
    // A late joiner sees it in the roster.
    const { welcome } = await Client.join(roomId, USERS.admin.id);
    expect(welcome.voice?.find((p) => p.userId === USERS.member1.id)?.camera).toBe(true);

    // Publishing again replaces it (the old one is closed first).
    const again = await publishCamera(roomId, USERS.member1.id, sessionId);
    expect(again.status).toBe(201);
    expect(sfu.of('PUT /sessions/:id/tracks/close').map((c) => c.body.tracks)).toContainEqual([
      { mid: '2' },
    ]);
    // Unpublish turns it off for everyone.
    await watcher.drain('voice.updated');
    await viewer.client.drain('voice.tracks');
    expect(
      (
        await rest(
          'POST',
          `/rtc/rooms/${roomId}/camera/unpublish`,
          { user: USERS.member1.id },
          { sessionId },
        )
      ).status,
    ).toBe(204);
    expect((await watcher.take('voice.updated')).payload.participant.camera).toBeUndefined();
    expect((await viewer.client.take('voice.tracks')).payload.cameras).toEqual([]);
  });

  it('refuses cameras without the capability, and guests unless the room lets them', async () => {
    new FakeSfu().install();
    const noCamera = await newRoom({ settings: { capabilities: NO_CAMERA } });
    const a = await inVoice(noCamera, USERS.member1.id);
    expect(await publishCamera(noCamera, USERS.member1.id, a.sessionId)).toMatchObject({
      status: 403,
      body: { code: 'capability_disabled', capability: 'camera' },
    });
    expect(await subscribeCameras(noCamera, USERS.member1.id, a.sessionId, ['ct_x'])).toMatchObject(
      {
        status: 403,
        body: { code: 'capability_disabled', capability: 'camera' },
      },
    );
    expect(await a.client.request('voice.cameraOff', { userId: USERS.member1.id })).toMatchObject({
      type: 'error',
      payload: { code: 'capability_disabled', capability: 'camera' },
    });
    // Cleanup routes stay open.
    expect(
      (
        await rest(
          'POST',
          `/rtc/rooms/${noCamera}/camera/unpublish`,
          { user: USERS.member1.id },
          { sessionId: a.sessionId },
        )
      ).status,
    ).toBe(204);

    const roomId = await cameraRoom();
    const guest = await inVoice(roomId, USERS.guest1.id);
    expect(await publishCamera(roomId, USERS.guest1.id, guest.sessionId)).toMatchObject({
      status: 403,
      body: { code: 'camera_not_allowed' },
    });
    // The room lets guests: permissions.changed, then the camera goes on.
    await changeSettings(roomId, { capabilities: CAMERA, guestsCanUseCamera: true });
    expect((await guest.client.take('permissions.changed')).payload.you.permissions).toMatchObject({
      canUseCamera: true,
    });
    expect((await publishCamera(roomId, USERS.guest1.id, guest.sessionId)).status).toBe(201);
    // ... and back: their camera is turned off, with the reason.
    await changeSettings(roomId, { capabilities: CAMERA });
    expect((await guest.client.take('voice.cameraStopped')).payload).toEqual({
      reason: 'not_allowed',
    });
  });

  it('caps the cameras at maxCameras (your own does not count) and enforces a lower limit', async () => {
    new FakeSfu().install();
    const roomId = await cameraRoom({ maxCameras: 2 });
    const a = await inVoice(roomId, USERS.member1.id);
    const b = await inVoice(roomId, USERS.member2.id);
    const c = await inVoice(roomId, USERS.admin.id);
    expect((await publishCamera(roomId, USERS.member1.id, a.sessionId)).status).toBe(201);
    expect((await publishCamera(roomId, USERS.member2.id, b.sessionId)).status).toBe(201);
    expect(await publishCamera(roomId, USERS.admin.id, c.sessionId)).toMatchObject({
      status: 409,
      body: { code: 'camera_limit_reached', limit: 2 },
    });
    // Replacing your own camera at the limit is fine.
    expect((await publishCamera(roomId, USERS.member2.id, b.sessionId)).status).toBe(201);
    // The room lowers the limit to 1: the newest camera goes.
    await changeSettings(roomId, { capabilities: CAMERA, maxCameras: 1 });
    expect((await b.client.take('voice.cameraStopped')).payload).toEqual({ reason: 'limit' });
    expect(await a.client.drain('voice.cameraStopped')).toEqual([]);
    // Turning cameras off takes every camera down; the voice stays.
    await changeSettings(roomId, { capabilities: NO_CAMERA });
    expect((await a.client.take('voice.cameraStopped')).payload).toEqual({
      reason: 'capability_disabled',
    });
    expect(await a.client.drain('voice.left')).toEqual([]);
  });

  it('pulls cameras on the strip layer, switches to the high one, and closes an old pull first', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await cameraRoom();
    const viewer = await inVoice(roomId, USERS.owner.id);
    const a = await inVoice(roomId, USERS.member1.id);
    const b = await inVoice(roomId, USERS.member2.id);
    const camA = await publishCamera(roomId, USERS.member1.id, a.sessionId);
    const camB = await publishCamera(roomId, USERS.member2.id, b.sessionId, {
      type: 'offer',
      sdp: sdp([]),
    });
    expect(camB.body.rids).toEqual([]);
    // Your own camera is never in your list.
    expect(
      await subscribeCameras(roomId, USERS.member1.id, a.sessionId, [camA.body.trackId]),
    ).toMatchObject({ status: 404, body: { code: 'voice_track_not_found' } });
    // A layer the camera does not have.
    expect(
      await subscribeCameras(roomId, USERS.owner.id, viewer.sessionId, [camA.body.trackId], 'f'),
    ).toMatchObject({ status: 400, body: { code: 'invalid_message', path: '/rid' } });

    const res = await subscribeCameras(roomId, USERS.owner.id, viewer.sessionId, [
      camA.body.trackId,
      camB.body.trackId,
    ]);
    expect(res).toMatchObject({
      status: 200,
      body: {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer' },
        tracks: [
          { trackId: camA.body.trackId, userId: USERS.member1.id, rid: 'l' },
          { trackId: camB.body.trackId, userId: USERS.member2.id },
        ],
      },
    });
    // The strip pulls the low layer (simulcast policy); a camera without layers pulls as is.
    const pull = sfu.of('POST /sessions/:id/tracks/new').at(-1);
    expect(pull?.sessionId).toBe(viewer.sessionId);
    expect(pull?.body.tracks).toEqual([
      {
        location: 'remote',
        sessionId: a.sessionId,
        trackName: camA.body.trackId,
        simulcast: { preferredRid: 'l', priorityOrdering: 'none', ridNotAvailable: 'asciibetical' },
      },
      { location: 'remote', sessionId: b.sessionId, trackName: camB.body.trackId },
    ]);
    const midA = res.body.tracks[0].mid as string;

    // Enlarge: tracks/update to the high layer on the same mid.
    const layer = (trackId: string, rid: string) =>
      rest(
        'PUT',
        `/rtc/rooms/${roomId}/camera/layer`,
        { user: USERS.owner.id },
        { sessionId: viewer.sessionId, trackId, rid },
      );
    expect((await layer(camA.body.trackId, 'h')).status).toBe(204);
    expect(sfu.of('PUT /sessions/:id/tracks/update').at(-1)?.body.tracks).toEqual([
      {
        location: 'remote',
        sessionId: a.sessionId,
        trackName: camA.body.trackId,
        simulcast: { preferredRid: 'h', priorityOrdering: 'none', ridNotAvailable: 'asciibetical' },
        mid: midA,
      },
    ]);
    expect(await layer(camA.body.trackId, 'x')).toMatchObject({
      status: 400,
      body: { path: '/rid' },
    });
    expect(await layer('ct_nope', 'h')).toMatchObject({
      status: 404,
      body: { code: 'voice_track_not_found', trackId: 'ct_nope' },
    });

    // Pulling it again closes the old pull first, never twice.
    const closesBefore = sfu.of('PUT /sessions/:id/tracks/close').length;
    expect(
      (await subscribeCameras(roomId, USERS.owner.id, viewer.sessionId, [camA.body.trackId], 'h'))
        .status,
    ).toBe(200);
    const closes = sfu.of('PUT /sessions/:id/tracks/close').slice(closesBefore);
    expect(closes.map((c) => [c.sessionId, c.body.tracks])).toContainEqual([
      viewer.sessionId,
      [{ mid: midA }],
    ]);

    // The camera's owner leaves voice: their camera and its pulls close.
    await a.client.request('voice.leave', {});
    const lists = await viewer.client.drain('voice.tracks');
    expect(lists.at(-1)?.payload.cameras).toEqual([
      { trackId: camB.body.trackId, userId: USERS.member2.id, rids: [] },
    ]);
    expect(
      (
        await rest(
          'POST',
          `/rtc/rooms/${roomId}/camera/unsubscribe`,
          { user: USERS.owner.id },
          { sessionId: viewer.sessionId },
        )
      ).status,
    ).toBe(204);
  });

  it('closes the camera when the voice moves to another tab', async () => {
    new FakeSfu().install();
    const roomId = await cameraRoom();
    const { client: watcher } = await Client.join(roomId, USERS.owner.id);
    const a = await inVoice(roomId, USERS.member1.id);
    expect((await publishCamera(roomId, USERS.member1.id, a.sessionId)).status).toBe(201);
    await watcher.drain('voice.updated');
    const { client: tab2 } = await Client.join(roomId, USERS.member1.id, { tabId: 't_two' });
    await tab2.request('voice.join', {});
    expect((await a.client.take('voice.left')).payload.reason).toBe('moved');
    expect((await watcher.take('voice.updated')).payload.participant.camera).toBeUndefined();
  });
});

describe('moderation', () => {
  it("turns someone's camera off; they may turn it on again", async () => {
    new FakeSfu().install();
    const roomId = await cameraRoom();
    const owner = await inVoice(roomId, USERS.owner.id);
    const target = await inVoice(roomId, USERS.member1.id);
    const member = await inVoice(roomId, USERS.member2.id);
    expect((await publishCamera(roomId, USERS.member1.id, target.sessionId)).status).toBe(201);
    // A member may not.
    expect(
      await member.client.request('voice.cameraOff', { userId: USERS.member1.id }),
    ).toMatchObject({ type: 'error', payload: { code: 'forbidden' } });
    expect(await owner.client.request('voice.cameraOff', { userId: USERS.admin.id })).toMatchObject(
      { type: 'error', payload: { code: 'voice_not_joined', userId: USERS.admin.id } },
    );
    await owner.client.drain('voice.updated');
    expect(
      await owner.client.request('voice.cameraOff', { userId: USERS.member1.id }),
    ).toMatchObject({ type: 'ack' });
    expect((await target.client.take('voice.cameraStopped')).payload).toEqual({
      reason: 'moderator',
    });
    expect((await owner.client.take('voice.updated')).payload.participant).toEqual(
      expect.not.objectContaining({ camera: true }),
    );
    // Already off: ack again.
    expect(
      await owner.client.request('voice.cameraOff', { userId: USERS.member1.id }),
    ).toMatchObject({ type: 'ack' });
    expect((await publishCamera(roomId, USERS.member1.id, target.sessionId)).status).toBe(201);
  });
});

describe('quota brake and usage meter', () => {
  it('meters each camera pull at its layer, blocks new cameras at 100 % and keeps voice', async () => {
    new FakeSfu().install();
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    const roomId = await cameraRoom();
    const a = await inVoice(roomId, USERS.member1.id);
    const b = await inVoice(roomId, USERS.member2.id);
    const camA = await publishCamera(roomId, USERS.member1.id, a.sessionId);
    const camB = await publishCamera(roomId, USERS.member2.id, b.sessionId);
    // One on the strip layer, one enlarged.
    expect(
      (await subscribeCameras(roomId, USERS.member1.id, a.sessionId, [camB.body.trackId])).status,
    ).toBe(200);
    expect(
      (await subscribeCameras(roomId, USERS.member2.id, b.sessionId, [camA.body.trackId], 'h'))
        .status,
    ).toBe(200);
    const usage = () =>
      env.DB.prepare(
        'SELECT egress_gb_est AS gb, viewer_minutes AS vm FROM usage_daily WHERE space_id = ?',
      )
        .bind(SPACE_ID)
        .first<{ gb: number; vm: number }>();
    const o = overheads(true);
    // The two pulls were charged one join each at the high layer's rate.
    await roomStub(roomId).flushUsage();
    expect((await usage())?.gb).toBeGreaterThanOrEqual(2 * joinGB(CAMERA_LAYERS.h.kbps / 1000, o));
    // Start the minute after the joins, so only the per-layer seconds are compared below.
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    await elapseMeter(roomId, 60_000);
    await roomStub(roomId).flushUsage();
    const row = await usage();
    const kbps = CAMERA_LAYERS.l.kbps + CAMERA_LAYERS.h.kbps;
    // At least the 60 s shifted, plus the real seconds the test took (a few at most under load).
    expect(row?.gb).toBeGreaterThanOrEqual(viewerStreamGB(kbps / 1000, 60, o));
    expect(row?.gb).toBeLessThan(viewerStreamGB(kbps / 1000, 65, o));
    expect(row?.vm).toBe(0);

    // At 100 % of the quota: no new camera, the voice goes on.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      const c = await inVoice(roomId, USERS.admin.id);
      expect(await publishCamera(roomId, USERS.admin.id, c.sessionId)).toMatchObject({
        status: 403,
        body: { code: 'quota_exhausted' },
      });
      expect(
        (
          await rest(
            'POST',
            `/rtc/rooms/${roomId}/voice/publish`,
            { user: USERS.admin.id },
            { sessionId: c.sessionId, sessionDescription: CAMERA_OFFER, mid: '1' },
          )
        ).status,
      ).toBe(201);
      // After the grace period the running cameras are turned off too; nobody leaves voice.
      await roomStub(roomId).flushUsage();
      await runInDurableObject(roomStub(roomId), async (_, state) => {
        state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'quota_blocked_at'");
      });
      await roomStub(roomId).flushUsage();
      expect((await a.client.take('voice.cameraStopped')).payload).toEqual({
        reason: 'quota_exhausted',
      });
      expect((await b.client.take('voice.cameraStopped')).payload).toEqual({
        reason: 'quota_exhausted',
      });
      expect(await a.client.drain('voice.left')).toEqual([]);
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });
});
