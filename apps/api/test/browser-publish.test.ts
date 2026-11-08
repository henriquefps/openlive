// SPDX-License-Identifier: AGPL-3.0-only
import type { PayloadOf } from '@openlive/protocol';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, roomStub, seed, SPACE_ID, USERS } from './room-helpers';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

// Streaming from the browser (protocol 1.22, docs/PROTOCOL.md 7.2 and 11.2): a web tab publishes
// its own SFU session through the browser routes and announces it on its own room socket; the room
// treats it like a helper's stream, at most 1080p60.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

interface Who {
  user: string;
  device?: string;
}

async function rest(
  method: string,
  path: string,
  who: Who,
  body?: unknown,
  contentType = 'application/json',
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { [DEV_USER_HEADER]: who.user };
  if (who.device) headers[DEV_DEVICE_HEADER] = who.device;
  if (body !== undefined) headers['Content-Type'] = contentType;
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const TAB = 't_tab1';
const STREAMER = { user: USERS.member1.id };
const TRACKS = [
  { mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
  { mid: '1', trackName: 'audio', kind: 'audio' },
] as const;
const PUBLISH = {
  tabId: TAB,
  sessionDescription: offer,
  tracks: TRACKS,
  preset: 'game',
  maxBitrateKbps: 9000,
};
const ANNOUNCE: Omit<PayloadOf<'stream.announce'>, 'sfuSessionId'> = {
  source: { kind: 'screen', label: 'Entire screen' },
  preset: 'game',
  hasAudio: true,
  tracks: [
    { name: 'video', kind: 'video', rids: ['f', 'h', 'q'] },
    { name: 'audio', kind: 'audio' },
  ],
};

const publishUrl = (roomId: string) => `/rtc/rooms/${roomId}/browser/publish`;

/** The streamer's tab: its room socket (with `tabId`), publish, then announce on that socket. */
async function browserStream(roomId: string, tabId = TAB, user: string = STREAMER.user) {
  const { client: tab } = await Client.join(roomId, user, { tabId });
  const pub = await rest('POST', publishUrl(roomId), { user }, { ...PUBLISH, tabId });
  expect(pub.status).toBe(201);
  const started = await tab.request('stream.announce', {
    ...ANNOUNCE,
    sfuSessionId: pub.body.sfuSessionId,
  });
  if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
  return {
    tab,
    stream: started.payload.stream,
    streamId: started.payload.stream.streamId,
    sfuSessionId: pub.body.sfuSessionId as string,
  };
}

describe('browser publish', () => {
  it('publishes from a tab, announces on its socket, and everyone sees origin browser', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { client: viewer } = await Client.join(roomId, USERS.member2.id);
    const { stream, sfuSessionId } = await browserStream(roomId);
    expect(stream).toMatchObject({
      userId: STREAMER.user,
      origin: 'browser',
      preset: 'game',
      deviceId: expect.stringMatching(/^wb_/),
    });
    expect(stream).not.toHaveProperty('pingOverlay');
    expect((await viewer.take('stream.started')).payload.stream).toMatchObject({
      origin: 'browser',
    });
    // The same SFU calls as a helper's publish.
    expect(sfu.of('POST /sessions/:id/tracks/new')[0]?.body).toEqual({
      sessionDescription: offer,
      tracks: [
        { location: 'local', mid: '0', trackName: 'video' },
        { location: 'local', mid: '1', trackName: 'audio' },
      ],
    });
    const row = await env.DB.prepare('SELECT * FROM realtime_sessions WHERE session_id = ?')
      .bind(sfuSessionId)
      .first();
    expect(row).toMatchObject({
      space_id: SPACE_ID,
      room_id: roomId,
      kind: 'browser_publish',
      device_id: null,
    });
  });

  it('refuses helpers, presets above 1080p60, and tracks a browser does not send', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { allowedPresets: ['text', 'game', 'max'] } });
    const url = publishUrl(roomId);
    expect(await rest('POST', url, { ...STREAMER, device: 'd_pc1' }, PUBLISH)).toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    });
    // max is allowed in the room, but not from a browser.
    expect(await rest('POST', url, STREAMER, { ...PUBLISH, preset: 'max' })).toMatchObject({
      status: 403,
      body: { code: 'preset_not_allowed', preset: 'max' },
    });
    expect(await rest('POST', url, STREAMER, { ...PUBLISH, preset: 'game120' })).toMatchObject({
      status: 403,
      body: { code: 'preset_not_allowed', preset: 'game120' },
    });
    const bad = [
      [TRACKS[1]],
      [TRACKS[0], { ...TRACKS[0], trackName: 'v2', mid: '2' }],
      [{ ...TRACKS[0], codec: 'av1' }],
      [{ ...TRACKS[0], rids: ['q', 'f'] }],
      [{ ...TRACKS[0], rids: ['x'] }],
    ];
    for (const tracks of bad) {
      expect(await rest('POST', url, STREAMER, { ...PUBLISH, tracks })).toMatchObject({
        status: 400,
        body: { code: 'invalid_message', path: '/tracks' },
      });
    }
    // Two layers are fine; so is a stream without audio.
    expect(
      (
        await rest('POST', url, STREAMER, {
          ...PUBLISH,
          tracks: [{ ...TRACKS[0], rids: ['f', 'q'] }],
        })
      ).status,
    ).toBe(201);
  });

  it('refuses guests without the permission and bitrates above the room', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { maxBitrateKbps: 8000 } });
    expect(
      await rest('POST', publishUrl(roomId), { user: USERS.guest1.id }, PUBLISH),
    ).toMatchObject({ status: 403, body: { code: 'stream_permission_required', roomId } });
    expect(await rest('POST', publishUrl(roomId), STREAMER, PUBLISH)).toMatchObject({
      status: 403,
      body: { code: 'bitrate_not_allowed', limit: 8000 },
    });
  });

  it('allows one browser stream per user per room, and counts it against the stream limit', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { maxStreams: 2 } });
    await browserStream(roomId);
    // Another tab of the same user: busy, announced or not.
    expect(
      await rest('POST', publishUrl(roomId), STREAMER, { ...PUBLISH, tabId: 't_tab2' }),
    ).toMatchObject({ status: 409, body: { code: 'browser_stream_busy', roomId } });
    // Another user's pending publication holds the second stream.
    expect(
      (await rest('POST', publishUrl(roomId), { user: USERS.member2.id }, PUBLISH)).status,
    ).toBe(201);
    expect(await rest('POST', publishUrl(roomId), { user: USERS.owner.id }, PUBLISH)).toMatchObject(
      { status: 409, body: { code: 'stream_limit_reached', limit: 2 } },
    );
  });

  it('blocks new browser streams when the quota brake is on', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      'INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      expect(await rest('POST', publishUrl(roomId), STREAMER, PUBLISH)).toMatchObject({
        status: 403,
        body: { code: 'quota_exhausted' },
      });
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });

  it('accepts the announce only from the tab that owns the publication', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const pub = await rest('POST', publishUrl(roomId), STREAMER, PUBLISH);
    const announce = { ...ANNOUNCE, sfuSessionId: pub.body.sfuSessionId };
    // Same user, another tab.
    const { client: other } = await Client.join(roomId, STREAMER.user, { tabId: 't_other' });
    expect(await other.request('stream.announce', announce)).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    // Another user claiming the same tab id.
    const { client: thief } = await Client.join(roomId, USERS.member2.id, { tabId: TAB });
    expect(await thief.request('stream.announce', announce)).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    // The owning tab, with a preset above 1080p60: refused even where the room allows it.
    const { client: tab } = await Client.join(roomId, STREAMER.user, { tabId: TAB });
    expect(await tab.request('stream.announce', { ...announce, preset: 'native' })).toMatchObject({
      type: 'error',
      payload: { code: 'preset_not_allowed' },
    });
    expect((await tab.request('stream.announce', announce)).type).toBe('stream.started');
  });

  it('updates and ends from the owning tab only; a browser preset stays at most 1080p60', async () => {
    new FakeSfu().install();
    const roomId = await newRoom({ settings: { allowedPresets: ['text', 'game', 'max'] } });
    const { client: viewer } = await Client.join(roomId, USERS.member2.id);
    const { tab, streamId } = await browserStream(roomId);
    const { client: other } = await Client.join(roomId, STREAMER.user, { tabId: 't_other' });
    expect(await other.request('stream.update', { streamId, paused: true })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    expect(await tab.request('stream.update', { streamId, preset: 'max' })).toMatchObject({
      type: 'error',
      payload: { code: 'preset_not_allowed', preset: 'max' },
    });
    expect((await tab.request('stream.update', { streamId, preset: 'text' })).type).toBe('ack');
    expect((await viewer.take('stream.updated')).payload.stream).toMatchObject({
      preset: 'text',
      origin: 'browser',
    });
    expect((await other.request('stream.end', { streamId })).type).toBe('error');
    expect((await tab.request('stream.end', { streamId })).type).toBe('ack');
    expect((await viewer.take('stream.ended')).payload).toEqual({
      streamId,
      reason: 'ended_by_streamer',
    });
  });

  it('sends stream.stop to the tab on stream.terminate and on a revoked permission', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: admin } = await Client.join(roomId, USERS.admin.id);
    const first = await browserStream(roomId);
    expect((await admin.request('stream.terminate', { streamId: first.streamId })).type).toBe(
      'ack',
    );
    expect((await first.tab.take('stream.stop')).payload).toEqual({
      streamId: first.streamId,
      reason: 'ended_by_moderator',
    });
    const second = await browserStream(roomId, 't_tab2');
    await roomStub(roomId).permissionsChanged(STREAMER.user, {
      role: 'member',
      permissions: { canStream: false, canModerate: false },
    });
    expect((await second.tab.take('stream.stop')).payload).toEqual({
      streamId: second.streamId,
      reason: 'permission_revoked',
    });
  });

  it('keeps the stream 15 s after the tab drops, for the same tab, then ends it', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { client: viewer } = await Client.join(roomId, USERS.member2.id);
    const first = await browserStream(roomId);
    const grace = () =>
      runInDurableObject(
        roomStub(roomId),
        async (_, state) =>
          state.storage.sql
            .exec<{ g: number | null }>('SELECT grace_until AS g FROM stream_sfu')
            .one().g,
      );
    // Another tab of the same user does not hold it.
    const { client: other } = await Client.join(roomId, STREAMER.user, { tabId: 't_other' });
    first.tab.close();
    await first.tab.closed;
    await viewer.drain('stream.updated');
    expect(await grace()).toBeGreaterThan(Date.now());
    // The same tab reconnecting within the grace keeps it.
    const { client: again } = await Client.join(roomId, STREAMER.user, { tabId: TAB });
    expect(await grace()).toBeNull();
    again.close();
    await again.closed;
    other.close();
    await other.closed;
    await viewer.drain('member.left');
    expect(await grace()).toBeGreaterThan(Date.now());
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      state.storage.sql.exec('UPDATE stream_sfu SET grace_until = 1');
    });
    await runDurableObjectAlarm(roomStub(roomId));
    expect((await viewer.take('stream.ended')).payload).toEqual({
      streamId: first.streamId,
      reason: 'helper_disconnected',
    });
  });

  it('unpublishes from a beacon (text/plain), idempotently, only for the owner', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { client: viewer } = await Client.join(roomId, USERS.member2.id);
    const { streamId, sfuSessionId } = await browserStream(roomId);
    const url = `/rtc/rooms/${roomId}/browser/unpublish`;
    expect(
      await rest('POST', url, { user: USERS.member2.id }, { sfuSessionId }, 'text/plain'),
    ).toMatchObject({ status: 404, body: { code: 'sfu_session_not_found' } });
    // The helper route does not end a browser publication.
    expect(
      await rest(
        'POST',
        `/rtc/rooms/${roomId}/unpublish`,
        { ...STREAMER, device: 'd_pc1' },
        {
          sfuSessionId,
        },
      ),
    ).toMatchObject({ status: 404 });
    expect(
      (await rest('POST', url, STREAMER, { sfuSessionId }, 'text/plain;charset=UTF-8')).status,
    ).toBe(204);
    expect((await viewer.take('stream.ended')).payload).toEqual({
      streamId,
      reason: 'ended_by_streamer',
    });
    await sfu.until('PUT /sessions/:id/tracks/close', 1);
    expect((await rest('POST', url, STREAMER, { sfuSessionId })).status).toBe(204);
  });

  it('renegotiates the own browser publication only', async () => {
    const sfu = new FakeSfu().install();
    const roomId = await newRoom();
    const { sfuSessionId } = await browserStream(roomId);
    const url = `/rtc/rooms/${roomId}/browser/publish/renegotiate`;
    const body = { sfuSessionId, sessionDescription: offer };
    expect((await rest('PUT', url, { user: USERS.member2.id }, body)).status).toBe(404);
    expect((await rest('PUT', url, STREAMER, body)).status).toBe(200);
    expect(sfu.of('PUT /sessions/:id/renegotiate')).toHaveLength(1);
  });

  it("takes the owner's thumbnail upload from the web session", async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await browserStream(roomId);
    const image = new Uint8Array(64).fill(1);
    image.set([0xff, 0xd8, 0xff, 0xe0]);
    const put = (user: string) =>
      exports.default.fetch(
        `http://localhost/api/rtc/rooms/${roomId}/streams/${streamId}/thumbnail`,
        {
          method: 'PUT',
          headers: { [DEV_USER_HEADER]: user, 'Content-Type': 'image/jpeg' },
          body: image,
        },
      );
    expect((await put(USERS.member2.id)).status).toBe(404);
    expect((await put(STREAMER.user)).status).toBe(204);
  });

  it('ends browser streams with the quota brake, telling the tab', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { tab, streamId } = await browserStream(roomId);
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    await env.DB.prepare(
      'INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes) VALUES (?, ?, 990, 0, 0)',
    )
      .bind(SPACE_ID, day)
      .run();
    try {
      await roomStub(roomId).flushUsage();
      await runInDurableObject(roomStub(roomId), async (_, state) => {
        state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'quota_blocked_at'");
      });
      await roomStub(roomId).flushUsage();
      expect((await tab.take('stream.stop')).payload).toEqual({
        streamId,
        reason: 'quota_exhausted',
      });
    } finally {
      await env.DB.prepare('DELETE FROM usage_daily WHERE space_id = ?').bind(SPACE_ID).run();
    }
  });
});
