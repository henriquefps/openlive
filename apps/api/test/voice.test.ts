// SPDX-License-Identifier: AGPL-3.0-only
import { overheads, viewerStreamGB, VOICE_KBPS } from '@openlive/usage';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { FakeSfu, offer } from './fake-sfu';
import { Client, elapseMeter, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { checkLimits, roomSettingsPatch, spaceSettingsPatch } from '../src/api/settings';
import { ApiError } from '../src/errors';
import { roomSettings } from '../src/room/access';
import { effectiveSettings } from '../src/room/settings';
import { mediaKindOfMid } from '../src/rtc/sdp';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// The voice channel (docs/PROTOCOL.md 7.5): the room messages,
// the voice routes of the SFU proxy (11.2) against the fake Realtime API, moderation, the
// capability, and the usage meter.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const VOICE = { stream: true, voice: true, camera: false, text: true };
const VOICE_ONLY = { stream: false, voice: true, camera: false, text: false };
const STREAM_ONLY = { stream: true, voice: false, camera: false, text: false };

const voiceRoom = (settings: Record<string, unknown> = {}) =>
  newRoom({ settings: { capabilities: VOICE, ...settings } });

/** An offer with a data channel (mid 0) and a sendonly microphone (mid 1). */
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

/** A web tab of `user` in the room, with its viewer session, joined to voice. */
async function inVoice(roomId: string, user: string, join: { muted?: boolean } = {}) {
  const session = await rest(
    'POST',
    `/rtc/rooms/${roomId}/session`,
    { user },
    {
      sessionDescription: offer,
    },
  );
  expect(session.status).toBe(201);
  const { client, welcome } = await Client.join(roomId, user);
  const joined = await client.request('voice.join', join);
  expect(joined).toMatchObject({
    type: 'voice.joined',
    payload: { participant: { userId: user } },
  });
  await client.take('voice.tracks');
  return { client, welcome, sessionId: session.body.sessionId as string };
}

const publish = (roomId: string, user: string, sessionId: string, mid = '1') =>
  rest(
    'POST',
    `/rtc/rooms/${roomId}/voice/publish`,
    { user },
    {
      sessionId,
      sessionDescription: MIC_OFFER,
      mid,
    },
  );

describe('sdp', () => {
  it('finds the media kind of a mid', () => {
    expect(mediaKindOfMid(MIC_OFFER.sdp, '1')).toBe('audio');
    expect(mediaKindOfMid(MIC_OFFER.sdp, '0')).toBe('application');
    expect(mediaKindOfMid(MIC_OFFER.sdp, '7')).toBeNull();
    expect(mediaKindOfMid('v=0\nm=video 9 RTP 96\na=mid:a\n', 'a')).toBe('video');
  });
});

describe('voice settings', () => {
  it('lowers maxVoiceParticipants level by level and reads guestsCanSpeak from the room', () => {
    expect(effectiveSettings(null, '{}')).toMatchObject({
      maxVoiceParticipants: 12,
      guestsCanSpeak: true,
    });
    expect(
      effectiveSettings(
        JSON.stringify({ maxVoiceParticipants: 8 }),
        JSON.stringify({ maxVoiceParticipants: 20, guestsCanSpeak: false }),
      ),
    ).toMatchObject({ maxVoiceParticipants: 8, guestsCanSpeak: false });
    // guestsCanSpeak is a room setting: a space cannot set it.
    expect(spaceSettingsPatch.safeParse({ guestsCanSpeak: false }).success).toBe(false);
    expect(roomSettingsPatch.safeParse({ guestsCanSpeak: false }).success).toBe(true);
  });

  it('refuses a voice limit above the level above it', () => {
    const ceiling = effectiveSettings(JSON.stringify({ maxVoiceParticipants: 6 }), null);
    expect(() => checkLimits({ maxVoiceParticipants: 7 }, ceiling, '/settings')).toThrow(
      expect.objectContaining({
        code: 'setting_above_ceiling',
        params: { path: '/settings/maxVoiceParticipants', limit: 6 },
      }),
    );
    expect(() => checkLimits({ maxVoiceParticipants: 6 }, ceiling, '/settings')).not.toThrow(
      ApiError,
    );
  });
});

describe('roster and permissions', () => {
  it('welcomes with the voice roster and the voice permissions', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    await inVoice(roomId, USERS.member1.id, { muted: true });
    const { welcome } = await Client.join(roomId, USERS.guest1.id);
    expect(welcome.you.permissions).toEqual({
      canStream: false,
      canModerate: false,
      canJoinVoice: true,
      canSpeak: true,
      canUseCamera: false,
      canReadChat: true,
      canWriteChat: true,
    });
    expect(welcome.settings).toMatchObject({ maxVoiceParticipants: 12, guestsCanSpeak: true });
    expect(welcome.voice).toEqual([
      {
        userId: USERS.member1.id,
        muted: true,
        deafened: false,
        serverMuted: false,
        joinedAt: expect.any(Number),
      },
    ]);
  });

  it('has no voice in a room without the capability', async () => {
    const roomId = await newRoom({ settings: { capabilities: STREAM_ONLY } });
    const { client, welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.voice).toBeUndefined();
    expect(welcome.you.permissions).toMatchObject({ canJoinVoice: false, canSpeak: false });
    for (const [type, payload] of [
      ['voice.join', {}],
      ['voice.state', { muted: true, deafened: false }],
      ['voice.serverMute', { userId: USERS.member2.id, muted: true }],
      ['voice.kick', { userId: USERS.member2.id }],
    ] as const) {
      expect(await client.request(type, payload)).toMatchObject({
        type: 'error',
        payload: { code: 'capability_disabled', capability: 'voice' },
      });
    }
    // Leaving always works.
    expect(await client.request('voice.leave', {})).toMatchObject({
      type: 'voice.left',
      payload: { userId: USERS.member1.id, reason: 'left' },
    });
  });

  it('refuses voice messages from a helper connection', async () => {
    const roomId = await voiceRoom();
    const { client } = await Client.join(roomId, USERS.member1.id, {
      client: 'helper',
      deviceId: 'd_pc1',
    });
    expect(await client.request('voice.join', {})).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden', roomId },
    });
  });

  it('keeps guests silent where the room says so, and tells them when it changes', async () => {
    const roomId = await voiceRoom({ guestsCanSpeak: false });
    const { client, welcome } = await Client.join(roomId, USERS.guest1.id);
    expect(welcome.you.permissions).toMatchObject({ canJoinVoice: true, canSpeak: false });
    // Joins as a listener: always muted.
    expect(await client.request('voice.join', {})).toMatchObject({
      type: 'voice.joined',
      payload: { participant: { userId: USERS.guest1.id, muted: true } },
    });
    expect(await client.request('voice.state', { muted: false, deafened: false })).toMatchObject({
      type: 'error',
      payload: { code: 'voice_speak_not_allowed' },
    });
    // Members still speak.
    const { client: member } = await Client.join(roomId, USERS.member1.id);
    expect(await member.request('voice.join', {})).toMatchObject({
      payload: { participant: { muted: false } },
    });
    // The room lets guests speak again: permissions.changed, then unmuting works.
    await env.DB.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?')
      .bind(JSON.stringify({ capabilities: VOICE }), roomId)
      .run();
    const settings = await roomSettings(env.DB, roomId);
    if (!settings) throw new Error('no settings');
    await roomStub(roomId).settingsChanged(settings);
    expect((await client.take('permissions.changed')).payload.you.permissions).toMatchObject({
      canSpeak: true,
    });
    expect(await client.request('voice.state', { muted: false, deafened: false })).toMatchObject({
      type: 'ack',
    });
  });

  it('caps the voice channel at maxVoiceParticipants, without using viewer slots', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom({ maxVoiceParticipants: 1, maxViewersPerStream: 0 });
    await inVoice(roomId, USERS.member1.id);
    const { client } = await Client.join(roomId, USERS.member2.id);
    expect(await client.request('voice.join', {})).toMatchObject({
      type: 'error',
      payload: { code: 'voice_full', limit: 1 },
    });
  });
});

describe('join, state, leave', () => {
  it('broadcasts join, state and leave to the room; deafen implies mute', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    const { client: watcher } = await Client.join(roomId, USERS.admin.id);
    const { client } = await inVoice(roomId, USERS.member1.id);
    expect((await watcher.take('voice.joined')).payload.participant).toMatchObject({
      userId: USERS.member1.id,
      muted: false,
      deafened: false,
    });
    expect(await client.request('voice.state', { muted: false, deafened: true })).toMatchObject({
      type: 'ack',
    });
    expect((await watcher.take('voice.updated')).payload.participant).toMatchObject({
      muted: true,
      deafened: true,
    });
    // Joining again from the same tab is idempotent.
    expect(await client.request('voice.join', {})).toMatchObject({
      type: 'voice.joined',
      payload: { participant: { deafened: true } },
    });
    expect(await client.request('voice.leave', {})).toMatchObject({
      type: 'voice.left',
      payload: { userId: USERS.member1.id, reason: 'left' },
    });
    expect((await watcher.take('voice.left')).payload).toEqual({
      userId: USERS.member1.id,
      reason: 'left',
    });
    expect(await client.request('voice.state', { muted: true, deafened: false })).toMatchObject({
      type: 'error',
      payload: { code: 'voice_not_joined' },
    });
    // Leaving again: the reply alone.
    expect(await client.request('voice.leave', {})).toMatchObject({ type: 'voice.left' });
    expect(await watcher.drain('voice.left')).toEqual([]);
  });

  it('takes a closed tab out of voice and closes its microphone and pulls', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const { client: watcher } = await Client.join(roomId, USERS.admin.id);
    const a = await inVoice(roomId, USERS.member1.id);
    const b = await inVoice(roomId, USERS.member2.id);
    expect((await publish(roomId, USERS.member1.id, a.sessionId)).status).toBe(201);
    const { trackId } = (await b.client.take('voice.tracks')).payload.tracks[0] ?? {};
    const sub = await rest(
      'POST',
      `/rtc/rooms/${roomId}/voice/subscribe`,
      {
        user: USERS.member2.id,
      },
      { sessionId: b.sessionId, trackIds: [trackId] },
    );
    expect(sub.status).toBe(200);
    a.client.close();
    expect(
      (await watcher.take('voice.left', (m) => m.payload.userId === USERS.member1.id)).payload,
    ).toEqual({ userId: USERS.member1.id, reason: 'disconnected' });
    expect((await b.client.take('voice.tracks')).payload.tracks).toEqual([]);
    const closes = await sfu.until('PUT /sessions/:id/tracks/close', 2);
    expect(closes.map((c) => [c.sessionId, c.body.tracks])).toEqual(
      expect.arrayContaining([
        [b.sessionId, [{ mid: sub.body.tracks[0].mid }]],
        [a.sessionId, [{ mid: '1' }]],
      ]),
    );
  });

  it('moves the voice to another tab of the same user', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    const { client: watcher } = await Client.join(roomId, USERS.admin.id);
    const first = await inVoice(roomId, USERS.member1.id);
    await watcher.take('voice.joined');
    const { client: second } = await Client.join(roomId, USERS.member1.id, { tabId: 't_2' });
    expect(await second.request('voice.join', { muted: true })).toMatchObject({
      type: 'voice.joined',
      payload: { participant: { userId: USERS.member1.id, muted: true } },
    });
    expect((await first.client.take('voice.left')).payload).toEqual({
      userId: USERS.member1.id,
      reason: 'moved',
    });
    expect((await watcher.take('voice.updated')).payload.participant.muted).toBe(true);
    expect(await watcher.drain('voice.left')).toEqual([]);
  });
});

describe('voice routes of the SFU proxy', () => {
  it('opens the viewer session in a voice-only room, and refuses voice routes without voice', async () => {
    new FakeSfu().install();
    const voiceOnly = await newRoom({ settings: { capabilities: VOICE_ONLY } });
    const user = { user: USERS.member1.id };
    expect(
      (await rest('POST', `/rtc/rooms/${voiceOnly}/session`, user, { sessionDescription: offer }))
        .status,
    ).toBe(201);
    const streamOnly = await newRoom({ settings: { capabilities: STREAM_ONLY } });
    const body = { sessionId: 'sess_x', sessionDescription: MIC_OFFER, mid: '1' };
    for (const route of ['voice/publish', 'voice/subscribe']) {
      const res = await rest(
        'POST',
        `/rtc/rooms/${streamOnly}/${route}`,
        user,
        route === 'voice/publish' ? body : { sessionId: 'sess_x', trackIds: ['vt_1'] },
      );
      expect(res).toMatchObject({
        status: 403,
        body: { code: 'capability_disabled', capability: 'voice' },
      });
    }
    // Cleanup routes stay open.
    expect(
      (await rest('POST', `/rtc/rooms/${streamOnly}/voice/unsubscribe`, user, { sessionId: 'x' }))
        .status,
    ).toBe(404);
  });

  it('publishes the microphone on the viewer session: audio only, in voice, own session', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const listener = await inVoice(roomId, USERS.member2.id);
    const session = await rest(
      'POST',
      `/rtc/rooms/${roomId}/session`,
      {
        user: USERS.member1.id,
      },
      { sessionDescription: offer },
    );
    const sessionId = session.body.sessionId as string;
    // Not in voice yet.
    expect(await publish(roomId, USERS.member1.id, sessionId)).toMatchObject({
      status: 409,
      body: { code: 'voice_not_joined' },
    });
    const { client } = await Client.join(roomId, USERS.member1.id);
    await client.request('voice.join', {});
    // Someone else's session.
    expect(await publish(roomId, USERS.member1.id, listener.sessionId)).toMatchObject({
      status: 404,
      body: { code: 'sfu_session_not_found' },
    });
    // The data channel is not a microphone; video is never published from the web here.
    expect(await publish(roomId, USERS.member1.id, sessionId, '0')).toMatchObject({
      status: 400,
      body: { code: 'invalid_message', path: '/mid' },
    });
    // A helper never publishes voice.
    expect(
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/voice/publish`,
        {
          user: USERS.member1.id,
          device: 'd_pc1',
        },
        { sessionId, sessionDescription: MIC_OFFER, mid: '1' },
      ),
    ).toMatchObject({ status: 403, body: { code: 'forbidden' } });

    const res = await publish(roomId, USERS.member1.id, sessionId);
    expect(res).toMatchObject({
      status: 201,
      body: {
        trackId: expect.stringMatching(/^vt_/),
        mid: '1',
        sessionDescription: { type: 'answer' },
      },
    });
    const call = sfu.of('POST /sessions/:id/tracks/new').at(-1);
    expect(call?.sessionId).toBe(sessionId);
    expect(call?.body).toEqual({
      sessionDescription: MIC_OFFER,
      tracks: [{ location: 'local', mid: '1', trackName: res.body.trackId }],
    });
    // The listener's voice.tracks gains it; the publisher's own list never has it.
    expect((await listener.client.take('voice.tracks')).payload.tracks).toEqual([
      { trackId: res.body.trackId, userId: USERS.member1.id },
    ]);
    // Publishing again closes the previous microphone first.
    const again = await publish(roomId, USERS.member1.id, sessionId);
    expect(again.status).toBe(201);
    expect(sfu.of('PUT /sessions/:id/tracks/close').map((c) => c.body.tracks)).toContainEqual([
      { mid: '1' },
    ]);
    const lists = await listener.client.drain('voice.tracks');
    expect(lists.at(-1)?.payload.tracks).toEqual([
      { trackId: again.body.trackId, userId: USERS.member1.id },
    ]);
    // Unpublish closes it and empties the list.
    expect(
      (
        await rest(
          'POST',
          `/rtc/rooms/${roomId}/voice/unpublish`,
          { user: USERS.member1.id },
          {
            sessionId,
          },
        )
      ).status,
    ).toBe(204);
    expect((await listener.client.take('voice.tracks')).payload.tracks).toEqual([]);
  });

  it('refuses the microphone of a guest who may not speak', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom({ guestsCanSpeak: false });
    const guest = await inVoice(roomId, USERS.guest1.id);
    expect(await publish(roomId, USERS.guest1.id, guest.sessionId)).toMatchObject({
      status: 403,
      body: { code: 'voice_speak_not_allowed' },
    });
  });

  it('pulls up to 4 microphones per request and closes an old pull before pulling again', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const listener = await inVoice(roomId, USERS.owner.id);
    const speakers = [USERS.member1.id, USERS.member2.id, USERS.admin.id, USERS.guest1.id];
    const trackIds: string[] = [];
    const sessions: string[] = [];
    for (const user of speakers) {
      const s = await inVoice(roomId, user);
      const pub = await publish(roomId, user, s.sessionId);
      expect(pub.status).toBe(201);
      trackIds.push(pub.body.trackId);
      sessions.push(s.sessionId);
    }
    const url = `/rtc/rooms/${roomId}/voice/subscribe`;
    const who = { user: USERS.owner.id };
    expect(
      await rest('POST', url, who, { sessionId: listener.sessionId, trackIds: [...trackIds, 'x'] }),
    ).toMatchObject({ status: 400, body: { code: 'invalid_message' } });
    expect(
      await rest('POST', url, who, { sessionId: listener.sessionId, trackIds: ['vt_gone'] }),
    ).toMatchObject({ status: 404, body: { code: 'voice_track_not_found', trackId: 'vt_gone' } });

    const res = await rest('POST', url, who, { sessionId: listener.sessionId, trackIds });
    expect(res).toMatchObject({
      status: 200,
      body: { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer' } },
    });
    expect(res.body.tracks).toEqual(
      speakers.map((userId, i) => ({ trackId: trackIds[i], userId, mid: expect.any(String) })),
    );
    const pull = sfu.of('POST /sessions/:id/tracks/new').at(-1);
    expect(pull?.sessionId).toBe(listener.sessionId);
    expect(pull?.body.tracks).toEqual(
      trackIds.map((trackName, i) => ({
        location: 'remote',
        sessionId: sessions[i],
        trackName,
      })),
    );
    // Own microphone is not pullable.
    const own = await publish(roomId, USERS.owner.id, listener.sessionId);
    expect(
      await rest('POST', url, who, { sessionId: listener.sessionId, trackIds: [own.body.trackId] }),
    ).toMatchObject({ status: 404, body: { code: 'voice_track_not_found' } });

    // Pulling one again: its old mid is closed before the new tracks/new.
    const before = sfu.calls.length;
    const again = await rest('POST', url, who, {
      sessionId: listener.sessionId,
      trackIds: [trackIds[0]],
    });
    expect(again.status).toBe(200);
    const ops = sfu.calls.slice(before).map((c) => c.op);
    expect(ops).toEqual(['PUT /sessions/:id/tracks/close', 'POST /sessions/:id/tracks/new']);
    expect(sfu.calls[before]?.body.tracks).toEqual([{ mid: res.body.tracks[0].mid }]);

    // Unsubscribe closes the pulls; renegotiate is the usual route.
    expect(
      (
        await rest('PUT', `/rtc/rooms/${roomId}/renegotiate`, who, {
          sessionId: listener.sessionId,
          sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await rest('POST', `/rtc/rooms/${roomId}/voice/unsubscribe`, who, {
          sessionId: listener.sessionId,
        })
      ).status,
    ).toBe(204);
    const closed = await runInDurableObject(roomStub(roomId), async (_, state) =>
      state.storage.sql.exec('SELECT count(*) AS n FROM voice_pulls').one(),
    );
    expect(closed.n).toBe(0);
  });

  it('refuses to pull when not in voice, and leave closes the voice of the session', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const speaker = await inVoice(roomId, USERS.member1.id);
    const pub = await publish(roomId, USERS.member1.id, speaker.sessionId);
    const outside = await rest(
      'POST',
      `/rtc/rooms/${roomId}/session`,
      {
        user: USERS.member2.id,
      },
      { sessionDescription: offer },
    );
    expect(
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/voice/subscribe`,
        { user: USERS.member2.id },
        {
          sessionId: outside.body.sessionId,
          trackIds: [pub.body.trackId],
        },
      ),
    ).toMatchObject({ status: 409, body: { code: 'voice_not_joined' } });
    // The speaker's tab goes away (sendBeacon): the microphone closes with the session.
    expect(
      (
        await rest(
          'POST',
          '/rtc/leave',
          { user: USERS.member1.id },
          {
            roomId,
            sessionId: speaker.sessionId,
          },
        )
      ).status,
    ).toBe(204);
    const closes = await sfu.until('PUT /sessions/:id/tracks/close', 1);
    expect(closes[0]).toMatchObject({
      sessionId: speaker.sessionId,
      body: { tracks: [{ mid: '1' }] },
    });
  });
});

describe('moderation', () => {
  it('server-mutes: closes the microphone, refuses a new one, and lifts', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const owner = await inVoice(roomId, USERS.owner.id);
    const target = await inVoice(roomId, USERS.member1.id);
    const pub = await publish(roomId, USERS.member1.id, target.sessionId);
    expect((await owner.client.take('voice.tracks')).payload.tracks).toHaveLength(1);

    // A member may not; an admin may not touch the owner.
    const { client: member } = await Client.join(roomId, USERS.member2.id);
    expect(
      await member.request('voice.serverMute', { userId: USERS.member1.id, muted: true }),
    ).toMatchObject({ type: 'error', payload: { code: 'forbidden', roomId } });
    const { client: admin } = await Client.join(roomId, USERS.admin.id);
    expect(
      await admin.request('voice.serverMute', { userId: USERS.owner.id, muted: true }),
    ).toMatchObject({ type: 'error', payload: { code: 'forbidden' } });
    expect(
      await admin.request('voice.serverMute', { userId: USERS.member2.id, muted: true }),
    ).toMatchObject({
      type: 'error',
      payload: { code: 'voice_not_joined', userId: USERS.member2.id },
    });

    expect(
      await admin.request('voice.serverMute', { userId: USERS.member1.id, muted: true }),
    ).toMatchObject({ type: 'ack' });
    expect((await member.take('voice.updated')).payload.participant).toMatchObject({
      userId: USERS.member1.id,
      serverMuted: true,
    });
    expect((await owner.client.take('voice.tracks')).payload.tracks).toEqual([]);
    const closes = await sfu.until('PUT /sessions/:id/tracks/close', 1);
    expect(closes[0]).toMatchObject({
      sessionId: target.sessionId,
      body: { tracks: [{ mid: '1' }] },
    });
    expect(pub.status).toBe(201);
    expect(await publish(roomId, USERS.member1.id, target.sessionId)).toMatchObject({
      status: 403,
      body: { code: 'voice_speak_not_allowed' },
    });

    expect(
      await admin.request('voice.serverMute', { userId: USERS.member1.id, muted: false }),
    ).toMatchObject({ type: 'ack' });
    expect((await member.take('voice.updated')).payload.participant.serverMuted).toBe(false);
    expect((await publish(roomId, USERS.member1.id, target.sessionId)).status).toBe(201);
  });

  it('keeps a server mute across leaving and joining again', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    const owner = await inVoice(roomId, USERS.owner.id);
    const target = await inVoice(roomId, USERS.member1.id);
    await owner.client.request('voice.serverMute', { userId: USERS.member1.id, muted: true });
    await target.client.request('voice.leave', {});
    expect(await target.client.request('voice.join', {})).toMatchObject({
      type: 'voice.joined',
      payload: { participant: { serverMuted: true } },
    });
    expect(await publish(roomId, USERS.member1.id, target.sessionId)).toMatchObject({
      status: 403,
      body: { code: 'voice_speak_not_allowed' },
    });
  });

  it('kicks out of voice: voice.left kicked, microphone and pulls closed', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await voiceRoom();
    const owner = await inVoice(roomId, USERS.owner.id);
    const target = await inVoice(roomId, USERS.admin.id);
    const { client: admin } = await Client.join(roomId, USERS.admin.id, { tabId: 't_other' });
    expect(await admin.request('voice.kick', { userId: USERS.owner.id })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    expect(await owner.client.request('voice.kick', { userId: USERS.owner.id })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    const pub = await publish(roomId, USERS.owner.id, owner.sessionId);
    const pulled = await rest(
      'POST',
      `/rtc/rooms/${roomId}/voice/subscribe`,
      {
        user: USERS.admin.id,
      },
      { sessionId: target.sessionId, trackIds: [pub.body.trackId] },
    );
    expect(pulled.status).toBe(200);
    const before = sfu.of('PUT /sessions/:id/tracks/close').length;

    expect(await owner.client.request('voice.kick', { userId: USERS.admin.id })).toMatchObject({
      type: 'ack',
    });
    expect((await target.client.take('voice.left')).payload).toEqual({
      userId: USERS.admin.id,
      reason: 'kicked',
    });
    const closes = await sfu.until('PUT /sessions/:id/tracks/close', before + 1);
    expect(closes.at(-1)).toMatchObject({
      sessionId: target.sessionId,
      body: { tracks: [{ mid: pulled.body.tracks[0].mid }] },
    });
    // They may join again.
    expect(await target.client.request('voice.join', {})).toMatchObject({ type: 'voice.joined' });
  });

  it('takes a removed or banned user out of voice before kicking them from the room', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    const { client: watcher } = await Client.join(roomId, USERS.owner.id);
    const target = await inVoice(roomId, USERS.member2.id);
    await roomStub(roomId).kick(USERS.member2.id, 'banned');
    expect((await watcher.take('voice.left')).payload).toEqual({
      userId: USERS.member2.id,
      reason: 'removed',
    });
    expect((await target.client.take('kicked')).payload.reason).toBe('banned');
    expect(await watcher.drain('voice.left')).toEqual([]);
  });

  it('takes everyone out with a notice when voice is turned off', async () => {
    new FakeSfu().install();
    const roomId = await voiceRoom();
    const a = await inVoice(roomId, USERS.member1.id);
    await inVoice(roomId, USERS.member2.id);
    await env.DB.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?')
      .bind(JSON.stringify({ capabilities: STREAM_ONLY }), roomId)
      .run();
    const settings = await roomSettings(env.DB, roomId);
    if (!settings) throw new Error('no settings');
    await roomStub(roomId).settingsChanged(settings);
    const left = [await a.client.take('voice.left'), await a.client.take('voice.left')];
    expect(left.map((m) => m.payload.reason)).toEqual([
      'capability_disabled',
      'capability_disabled',
    ]);
    expect((await a.client.take('room.updated')).payload.settings.capabilities?.voice).toBe(false);
    expect((await a.client.take('permissions.changed')).payload.you.permissions).toMatchObject({
      canJoinVoice: false,
    });
  });
});

describe('usage meter', () => {
  it('counts 32 kbps per pulled microphone and keeps voice going when the quota blocks', async () => {
    new FakeSfu().install();
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    const roomId = await voiceRoom();
    const a = await inVoice(roomId, USERS.member1.id);
    const b = await inVoice(roomId, USERS.member2.id);
    const pubA = await publish(roomId, USERS.member1.id, a.sessionId);
    const pubB = await publish(roomId, USERS.member2.id, b.sessionId);
    const sub = (user: string, sessionId: string, trackId: string) =>
      rest(
        'POST',
        `/rtc/rooms/${roomId}/voice/subscribe`,
        { user },
        {
          sessionId,
          trackIds: [trackId],
        },
      );
    expect((await sub(USERS.member1.id, a.sessionId, pubB.body.trackId)).status).toBe(200);
    expect((await sub(USERS.member2.id, b.sessionId, pubA.body.trackId)).status).toBe(200);
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await elapseMeter(roomId, 60_000);
    await roomStub(roomId).flushUsage();
    const row = await env.DB.prepare(
      'SELECT egress_gb_est AS gb, viewer_minutes AS vm FROM usage_daily WHERE space_id = ?',
    )
      .bind(SPACE_ID)
      .first<{ gb: number; vm: number }>();
    // Two listeners, one microphone each, for a minute: no viewer minutes, no joins.
    // At least the 60 s shifted, plus the real seconds the test took (a few at most under load).
    const voiceGB = (s: number) => viewerStreamGB((2 * VOICE_KBPS) / 1000, s, overheads(true));
    expect(row?.gb).toBeGreaterThanOrEqual(voiceGB(60));
    expect(row?.gb).toBeLessThan(voiceGB(65));
    expect(row?.vm).toBe(0);

    // At 100 % of the quota new streams are blocked, but voice goes on.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      await roomStub(roomId).flushUsage();
      expect((await publish(roomId, USERS.member1.id, a.sessionId)).status).toBe(201);
      expect((await sub(USERS.member2.id, b.sessionId, pubA.body.trackId)).status).toBe(404);
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });
});
