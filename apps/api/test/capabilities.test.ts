// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import { auditRows, call, fixedRoom, migrate, world } from './api-helpers';
import { Client, newRoom, roomStub, seed, testStream, USERS } from './room-helpers';

// Room capabilities: validation, the three levels, the defaults,
// changing them later, and the gating of stream messages and SFU proxy routes.

const ALL = { stream: true, voice: true, camera: true, text: true };
const STREAM_ONLY = { stream: true, voice: false, camera: false, text: false };
const WATCH_TOGETHER = { stream: true, voice: true, camera: false, text: true };
const VOICE = { stream: false, voice: true, camera: true, text: false };
const TEXT = { stream: false, voice: false, camera: false, text: true };

beforeAll(async () => {
  await migrate();
  await seed();
});

async function setPlatformCapabilities(value: typeof ALL | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM platform_settings WHERE key = 'capabilities'").run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('capabilities', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(JSON.stringify(value), Date.now())
    .run();
}

describe('defaults', () => {
  it('a fixed room is "Watch together" unless it asks for something else', async () => {
    const w = await world();
    const room = await call('GET', `/rooms/${await fixedRoom(w)}`, w.owner);
    expect(room.body.room.settings.capabilities).toEqual(WATCH_TOGETHER);
    expect(room.body.room.effectiveSettings.capabilities).toEqual(WATCH_TOGETHER);
    const text = await fixedRoom(w, { settings: { capabilities: TEXT } });
    expect(
      (await call('GET', `/rooms/${text}`, w.owner)).body.room.effectiveSettings,
    ).toMatchObject({ capabilities: TEXT });
  });

  it('a quick room has stream and voice', async () => {
    const w = await world();
    const res = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId });
    expect(res.status).toBe(201);
    expect(res.body.room.effectiveSettings.capabilities).toEqual({
      stream: true,
      voice: true,
      camera: false,
      text: false,
    });
    const voice = await call('POST', '/rooms/quick', w.member, {
      spaceId: w.spaceId,
      capabilities: VOICE,
    });
    expect(voice.body.room.effectiveSettings.capabilities).toEqual(VOICE);
  });

  it('a room that stored nothing is stream-only, as every room before capabilities', async () => {
    const roomId = await newRoom();
    const { client, welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.settings.capabilities).toEqual(STREAM_ONLY);
    client.ws.close();
  });

  it('the default fits what the space allows', async () => {
    const w = await world();
    const patch = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
      settings: { capabilities: { stream: true, voice: false, camera: false, text: true } },
    });
    expect(patch.status).toBe(200);
    const room = await call('GET', `/rooms/${await fixedRoom(w)}`, w.owner);
    expect(room.body.room.settings.capabilities).toEqual({
      stream: true,
      voice: false,
      camera: false,
      text: true,
    });
  });
});

describe('validation', () => {
  it('needs at least one of stream, voice and text, and camera only with voice', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const bad = [
      { stream: false, voice: false, camera: false, text: false },
      { stream: false, voice: false, camera: true, text: false },
      { stream: true, voice: false, camera: true, text: false },
      { stream: true, voice: true },
    ];
    for (const capabilities of bad) {
      const res = await call('PATCH', `/rooms/${roomId}`, w.owner, { settings: { capabilities } });
      expect(res.status, JSON.stringify(capabilities)).toBe(400);
      expect(res.body.code).toBe('invalid_message');
      expect(res.body.path).toMatch(/^\/settings\/capabilities/);
      const create = await call('POST', `/spaces/${w.spaceId}/rooms`, w.owner, {
        name: 'X',
        slug: 'x-bad',
        settings: { capabilities },
      });
      expect(create.status).toBe(400);
      const space = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
        settings: { capabilities },
      });
      expect(space.status).toBe(400);
    }
  });

  it("a quick room's creator does not change its capabilities", async () => {
    const w = await world();
    const quick = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId });
    const res = await call('PATCH', `/rooms/${quick.body.room.id}`, w.member, {
      settings: { capabilities: TEXT },
    });
    expect(res.status).toBe(403);
    const rename = await call('PATCH', `/rooms/${quick.body.room.id}`, w.member, { name: 'Ours' });
    expect(rename.status).toBe(200);
  });

  it('only owners and admins change a room', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    const res = await call('PATCH', `/rooms/${roomId}`, w.member, {
      settings: { capabilities: TEXT },
    });
    expect(res.status).toBe(403);
    const ok = await call('PATCH', `/rooms/${roomId}`, w.admin, {
      settings: { capabilities: TEXT },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.room.effectiveSettings.capabilities).toEqual(TEXT);
  });
});

describe('three levels', () => {
  it('a room cannot have what its space does not allow', async () => {
    const w = await world();
    await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
      settings: { capabilities: { stream: true, voice: true, camera: false, text: true } },
    });
    const res = await call('POST', `/spaces/${w.spaceId}/rooms`, w.owner, {
      name: 'Cams',
      slug: 'cams',
      settings: { capabilities: VOICE },
    });
    expect(res).toMatchObject({
      status: 400,
      body: { code: 'setting_above_ceiling', path: '/settings/capabilities/camera' },
    });
    const quick = await call('POST', '/rooms/quick', w.member, {
      spaceId: w.spaceId,
      capabilities: VOICE,
    });
    expect(quick.body).toMatchObject({ code: 'setting_above_ceiling' });
  });

  it('a space cannot allow what the platform does not, and the platform reduces every room', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    try {
      await setPlatformCapabilities({ stream: true, voice: true, camera: false, text: false });
      const res = await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
        settings: { capabilities: ALL },
      });
      expect(res).toMatchObject({
        status: 400,
        body: { code: 'setting_above_ceiling', path: '/settings/capabilities/camera' },
      });
      const space = await call('GET', `/spaces/${w.spaceId}`, w.owner);
      expect(space.body.space.effectiveSettings.capabilities).toEqual({
        stream: true,
        voice: true,
        camera: false,
        text: false,
      });
      // The room keeps its choice (Watch together) but effectively loses text.
      const room = await call('GET', `/rooms/${roomId}`, w.owner);
      expect(room.body.room.settings.capabilities).toEqual(WATCH_TOGETHER);
      expect(room.body.room.effectiveSettings.capabilities).toEqual({
        stream: true,
        voice: true,
        camera: false,
        text: false,
      });
      // Its other settings stay editable.
      expect((await call('PATCH', `/rooms/${roomId}`, w.owner, { name: 'Renamed' })).status).toBe(
        200,
      );
    } finally {
      await setPlatformCapabilities(null);
    }
  });

  it('the platform admin sets them in the admin settings, audited', async () => {
    const w = await world();
    const adminId = 'u_platform_caps';
    await env.DB.prepare(
      'INSERT OR IGNORE INTO users (id, display_name, is_platform_admin, created_at) VALUES (?, ?, 1, ?)',
    )
      .bind(adminId, 'Admin', Date.now())
      .run();
    try {
      const current = (await call('GET', '/admin/settings', adminId)).body.settings;
      expect(current.capabilities).toEqual(ALL);
      const next = { ...current, capabilities: { ...ALL, camera: false } };
      const res = await call('PUT', '/admin/settings', adminId, next);
      expect(res.body.settings.capabilities).toEqual(next.capabilities);
      const space = await call('GET', `/spaces/${w.spaceId}`, w.owner);
      expect(space.body.space.effectiveSettings.capabilities.camera).toBe(false);
      const audit = await env.DB.prepare(
        "SELECT data_json FROM audit_log WHERE action = 'platform.capabilities.update' AND actor_id = ?",
      )
        .bind(adminId)
        .first<{ data_json: string }>();
      expect(JSON.parse(audit?.data_json ?? '{}')).toEqual({ from: ALL, to: next.capabilities });
      // A client from before capabilities keeps the current ones.
      const legacy: Record<string, unknown> = { ...next };
      delete legacy['capabilities'];
      const kept = await call('PUT', '/admin/settings', adminId, legacy);
      expect(kept.body.settings.capabilities).toEqual(next.capabilities);
      const invalid = await call('PUT', '/admin/settings', adminId, {
        ...next,
        capabilities: { stream: false, voice: false, camera: false, text: false },
      });
      expect(invalid.status).toBe(400);
    } finally {
      await setPlatformCapabilities(null);
    }
  });
});

describe('changing them later', () => {
  it('audits the change on the room and on the space', async () => {
    const w = await world();
    const roomId = await fixedRoom(w);
    await call('PATCH', `/rooms/${roomId}`, w.owner, { settings: { capabilities: TEXT } });
    const rows = await auditRows(w.spaceId, 'room.capabilities.update');
    expect(rows.map((r) => [r.target, JSON.parse(r.data_json)])).toEqual([
      [roomId, { from: WATCH_TOGETHER, to: TEXT }],
    ]);
    // The same capabilities again: no new entry.
    await call('PATCH', `/rooms/${roomId}`, w.owner, { settings: { capabilities: TEXT } });
    expect(await auditRows(w.spaceId, 'room.capabilities.update')).toHaveLength(1);

    await call('PATCH', `/spaces/${w.spaceId}`, w.owner, {
      settings: { capabilities: { ...ALL, camera: false } },
    });
    const space = await auditRows(w.spaceId, 'space.capabilities.update');
    expect(space.map((r) => JSON.parse(r.data_json))).toEqual([
      { from: ALL, to: { ...ALL, camera: false } },
    ]);
  });

  it('turning stream off ends the live streams like a closed room, then room.updated', async () => {
    const roomId = await newRoom({ settings: { capabilities: WATCH_TOGETHER } });
    await roomStub(roomId).upsertStream(testStream('st_caps', 6));
    const { client, welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.streams.map((s) => s.streamId)).toEqual(['st_caps']);

    const res = await call('PATCH', `/rooms/${roomId}`, USERS.owner.id, {
      settings: { capabilities: { ...WATCH_TOGETHER, stream: false } },
    });
    expect(res.status).toBe(200);
    const ended = await client.take('stream.ended');
    expect(ended.payload).toEqual({ streamId: 'st_caps', reason: 'room_closed' });
    const updated = await client.take('room.updated');
    expect(updated.payload.settings.capabilities).toEqual({ ...WATCH_TOGETHER, stream: false });
    expect(await roomStub(roomId).liveStreamIds()).toEqual([]);

    // Voice and text changes are stored and announced; nothing else happens yet.
    await call('PATCH', `/rooms/${roomId}`, USERS.owner.id, { settings: { capabilities: TEXT } });
    expect((await client.take('room.updated')).payload.settings.capabilities).toEqual(TEXT);
    client.ws.close();
  });

  it('a space change reaches its open rooms', async () => {
    const roomId = await newRoom({ settings: { capabilities: WATCH_TOGETHER } });
    const { client } = await Client.join(roomId, USERS.member1.id);
    try {
      await call('PATCH', '/spaces/s1', USERS.owner.id, {
        settings: { capabilities: { ...ALL, text: false } },
      });
      const updated = await client.take('room.updated');
      expect(updated.payload.settings.capabilities).toEqual({ ...WATCH_TOGETHER, text: false });
    } finally {
      await call('PATCH', '/spaces/s1', USERS.owner.id, { settings: { capabilities: null } });
      client.ws.close();
    }
  });
});

describe('gating', () => {
  const STREAM_TYPES = [
    ['slot.request', { streamId: 'st_x' }],
    ['slot.renew', { slotId: 'sl_x' }],
    ['slot.release', { slotId: 'sl_x' }],
    ['queue.join', { streamId: 'st_x' }],
    ['queue.accept', { offerId: 'of_x' }],
    ['queue.leave', { streamId: 'st_x' }],
    ['stream.end', { streamId: 'st_x' }],
    ['stream.setViewerLimit', { streamId: 'st_x', limit: 2 }],
    ['stream.terminate', { streamId: 'st_x' }],
  ] as const;

  it('refuses every stream message in a room without stream (capability_disabled)', async () => {
    const roomId = await newRoom({ settings: { capabilities: VOICE } });
    const { client, welcome } = await Client.join(roomId, USERS.owner.id);
    expect(welcome.settings.capabilities).toEqual(VOICE);
    for (const [type, payload] of STREAM_TYPES) {
      const reply = await client.request(type, payload as never);
      expect(reply, type).toMatchObject({
        type: 'error',
        payload: { code: 'capability_disabled', capability: 'stream' },
      });
    }
    client.ws.close();
  });

  it('the helper cannot announce a stream in a room without stream', async () => {
    const roomId = await newRoom({ settings: { capabilities: TEXT } });
    const { client } = await Client.join(roomId, USERS.owner.id, {
      client: 'helper',
      deviceId: 'd_owner',
    });
    const reply = await client.request('stream.announce', {
      sfuSessionId: 'sfu_1',
      source: { kind: 'screen', label: 'Screen 1' },
      preset: 'game',
      tracks: [{ name: 'video', kind: 'video' }],
      hasAudio: false,
      viewerLimit: 2,
    });
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'capability_disabled' } });
    client.ws.close();
  });

  it('the SFU proxy refuses the media routes and keeps the clean-up ones', async () => {
    const roomId = await newRoom({ settings: { capabilities: TEXT } });
    const post = (path: string, body: unknown, method = 'POST', device = false) =>
      exports.default.fetch(`http://localhost/api/rtc/rooms/${roomId}/${path}`, {
        method,
        headers: {
          [DEV_USER_HEADER]: USERS.owner.id,
          ...(device ? { [DEV_DEVICE_HEADER]: 'd_owner' } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const sdp = { type: 'offer', sdp: 'v=0' };
    const refused: [string, unknown, string, boolean][] = [
      [
        'publish',
        {
          sessionDescription: sdp,
          tracks: [{ mid: '0', trackName: 'video', kind: 'video' }],
          preset: 'game',
          maxBitrateKbps: 1000,
        },
        'POST',
        true,
      ],
      ['publish/renegotiate', { sfuSessionId: 'sfu_1', sessionDescription: sdp }, 'PUT', true],
      ['session', {}, 'POST', false],
      ['subscribe', { sessionId: 'se_1', slotId: 'sl_1', streamId: 'st_1' }, 'POST', false],
      ['renegotiate', { sessionId: 'se_1', sessionDescription: sdp }, 'PUT', false],
      ['layer', { sessionId: 'se_1', streamId: 'st_1', rid: 'h' }, 'PUT', false],
    ];
    for (const [path, body, method, device] of refused) {
      const res = await post(path, body, method, device);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({
        code: 'capability_disabled',
        capability: 'stream',
      });
    }
    // Cleaning up stays possible: unsubscribe answers as without capabilities.
    const unsubscribe = await post('unsubscribe', { sessionId: 'se_1', streamId: 'st_1' });
    expect(unsubscribe.status).not.toBe(403);
  });
});
