// SPDX-License-Identifier: AGPL-3.0-only
import type { Message, PayloadOf, RoomPresence } from '@openlive/protocol';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextTick, PRESENCE_REFRESH_MS, ROOM_TICK_MS } from '../src/do/room';
import { PRESENCE_TTL_MS } from '../src/do/space';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import { Client, roomStub, seed, testStream, USERS } from './room-helpers';

// Room presence in the space sidebar (docs/PROTOCOL.md 7.8): RoomDO → SpaceDO summaries on
// voice join, leave, mute, stream start and end, the debounce, access filtering of restricted
// rooms, and the upgrade's checks.

beforeAll(seed);

const VOICE = { stream: true, voice: true, camera: true, text: true };
const nameOf = (userId: string) => `Name ${userId}`;

let spaceCounter = 0;

/** A fresh space per test (its own SpaceDO), with the seeded users in their roles. */
async function newSpace(): Promise<string> {
  spaceCounter += 1;
  const spaceId = `sp_presence_${spaceCounter}_${crypto.randomUUID().slice(0, 6)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO spaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(spaceId, 'Presence', spaceId, USERS.owner.id, now),
    ...Object.values(USERS)
      .filter((u) => u.role !== null)
      .map((u) =>
        env.DB.prepare(
          'INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        ).bind(spaceId, u.id, u.role, now),
      ),
  ]);
  return spaceId;
}

async function newRoomIn(spaceId: string, visibility: 'space' | 'restricted' = 'space') {
  const roomId = `r_presence_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO rooms (id, space_id, kind, name, slug, visibility, settings_json, created_at)
     VALUES (?, ?, 'fixed', ?, ?, ?, ?, ?)`,
  )
    .bind(
      roomId,
      spaceId,
      'Room',
      roomId,
      visibility,
      JSON.stringify({ capabilities: VOICE }),
      Date.now(),
    )
    .run();
  return roomId;
}

function spaceUpgrade(spaceId: string, userId?: string, deviceId?: string): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (userId) headers[DEV_USER_HEADER] = userId;
  if (deviceId) headers[DEV_DEVICE_HEADER] = deviceId;
  return exports.default.fetch(`http://localhost/ws/spaces/${spaceId}`, { headers });
}

/** A web tab following the space's presence, after its hello. */
async function subscribe(
  spaceId: string,
  userId: string,
): Promise<{ client: Client; presence: PayloadOf<'space.presence'> }> {
  const res = await spaceUpgrade(spaceId, userId);
  expect(res.status).toBe(101);
  const client = Client.adopt(res);
  const id = client.send('hello', {
    protocol: { major: 1, minor: 20 },
    client: 'web',
    clientVersion: '0.1.0',
    tabId: `t_${crypto.randomUUID().slice(0, 8)}`,
  });
  const presence = await client.take('space.presence');
  expect(presence.id).toBe(id);
  return { client, presence: presence.payload };
}

/** The next summary of `roomId` this subscriber gets (the debounce may hold it up to 1 s). */
async function nextOf(client: Client, roomId: string): Promise<RoomPresence> {
  const m = await client.take('space.presence.updated', (u) => u.payload.room.roomId === roomId);
  return m.payload.room;
}

async function rest(method: string, path: string, user: string, body?: unknown) {
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers: {
      [DEV_USER_HEADER]: user,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

/** Lets the RoomDO push at once again (no debounce wait), like a change 1 s later. */
async function pastDebounce(roomId: string): Promise<void> {
  await runInDurableObject(roomStub(roomId), (_, state) => {
    state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'presence_at'");
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the upgrade', () => {
  it('refuses outsiders, helpers and unknown spaces, and needs hello first', async () => {
    const spaceId = await newSpace();
    expect((await spaceUpgrade(spaceId)).status).toBe(401);
    expect((await spaceUpgrade(spaceId, USERS.outsider.id)).status).toBe(403);
    expect((await spaceUpgrade(spaceId, USERS.member1.id, 'd_pc')).status).toBe(403);
    const missing = await spaceUpgrade('sp_missing', USERS.member1.id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'space_not_found' });

    const res = await spaceUpgrade(spaceId, USERS.guest1.id);
    expect(res.status).toBe(101);
    const client = Client.adopt(res);
    expect(await client.request('voice.join', {})).toMatchObject({
      type: 'error',
      payload: { code: 'hello_required' },
    });
    // A cookie connection cannot claim to be a helper.
    expect(
      await client.request('hello', {
        protocol: { major: 1, minor: 20 },
        client: 'helper',
        clientVersion: '0.1.0',
        deviceId: 'd_pc',
      }),
    ).toMatchObject({ type: 'error', payload: { code: 'unauthenticated' } });
    expect((await client.closed).code).toBe(4001);
  });

  it('replaces an older connection of the same tab (4002)', async () => {
    const spaceId = await newSpace();
    const hello = {
      protocol: { major: 1, minor: 20 },
      client: 'web' as const,
      clientVersion: '0.1.0',
      tabId: 't_same',
    };
    const first = Client.adopt(await spaceUpgrade(spaceId, USERS.member1.id));
    await first.request('hello', hello);
    const second = Client.adopt(await spaceUpgrade(spaceId, USERS.member1.id));
    expect((await second.request('hello', hello)).type).toBe('space.presence');
    expect((await first.closed).code).toBe(4002);
  });
});

describe('RoomDO → SpaceDO summaries', () => {
  it('follows voice join, mute, deafen and leave', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: tab, presence } = await subscribe(spaceId, USERS.member2.id);
    expect(presence).toMatchObject({ spaceId, rooms: [], protocol: { major: 1, minor: 20 } });

    const { client: ana } = await Client.join(roomId, USERS.member1.id);
    expect((await ana.request('voice.join', {})).type).toBe('voice.joined');
    expect(await nextOf(tab, roomId)).toEqual({
      roomId,
      voice: [
        {
          userId: USERS.member1.id,
          displayName: nameOf(USERS.member1.id),
          muted: false,
          deafened: false,
        },
      ],
      live: [],
    });
    // A tab that subscribes now gets it in its snapshot.
    const late = await subscribe(spaceId, USERS.guest1.id);
    expect(late.presence.rooms.map((r) => r.roomId)).toEqual([roomId]);

    await pastDebounce(roomId);
    await ana.request('voice.state', { muted: true, deafened: false });
    expect((await nextOf(tab, roomId)).voice[0]).toMatchObject({ muted: true, deafened: false });

    // Within a second of the last push: held back, then sent by the alarm.
    await ana.request('voice.state', { muted: true, deafened: true });
    expect((await nextOf(tab, roomId)).voice[0]).toMatchObject({ muted: true, deafened: true });

    await pastDebounce(roomId);
    await ana.request('voice.leave', {});
    expect(await nextOf(tab, roomId)).toEqual({ roomId, voice: [], live: [] });
    expect((await subscribe(spaceId, USERS.member2.id)).presence.rooms).toEqual([]);
  });

  it('collapses a burst of changes into one push', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: tab } = await subscribe(spaceId, USERS.member2.id);
    const { client: ana } = await Client.join(roomId, USERS.member1.id);
    await ana.request('voice.join', {});
    expect((await nextOf(tab, roomId)).voice).toHaveLength(1);
    for (const muted of [true, false, true, false, true]) {
      await ana.request('voice.state', { muted, deafened: false });
    }
    expect((await nextOf(tab, roomId)).voice[0]).toMatchObject({ muted: true });
    await sleep(1_200);
    expect(tab.drainAll('space.presence.updated')).toEqual([]);
  });

  it('drops a participant whose tab closes', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: tab } = await subscribe(spaceId, USERS.member2.id);
    const { client: ana } = await Client.join(roomId, USERS.member1.id);
    await ana.request('voice.join', {});
    await nextOf(tab, roomId);
    await pastDebounce(roomId);
    ana.close();
    expect(await nextOf(tab, roomId)).toEqual({ roomId, voice: [], live: [] });
  });

  it('shows streams, with the streamer name when they are connected', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: tab } = await subscribe(spaceId, USERS.member2.id);
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    await roomStub(roomId).upsertStream(testStream('st_presence', 4));
    expect(await nextOf(tab, roomId)).toEqual({
      roomId,
      voice: [],
      live: [
        { userId: USERS.owner.id, displayName: nameOf(USERS.owner.id), streamId: 'st_presence' },
      ],
    });
    await pastDebounce(roomId);
    expect((await owner.request('stream.terminate', { streamId: 'st_presence' })).type).toBe('ack');
    expect(await nextOf(tab, roomId)).toEqual({ roomId, voice: [], live: [] });
  });

  it('pushes a live room again every 10 minutes and the SpaceDO drops a stale one', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: ana } = await Client.join(roomId, USERS.member1.id);
    await ana.request('voice.join', {});
    const space = env.SPACE.get(env.SPACE.idFromName(spaceId));
    // The push arrived and the SpaceDO set its expiry alarm.
    let updatedAt = 0;
    for (let i = 0; i < 20 && updatedAt === 0; i++) {
      updatedAt = await runInDurableObject(space, (_, state) => {
        const row = state.storage.sql
          .exec<{ updated_at: number }>('SELECT updated_at FROM room_presence')
          .toArray()[0];
        return row?.updated_at ?? 0;
      });
      if (updatedAt === 0) await sleep(50);
    }
    expect(updatedAt).toBeGreaterThan(0);
    await runInDurableObject(space, async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(updatedAt + PRESENCE_TTL_MS);
    });
    // The room's refresh is due on the first room tick past 5 minutes after its push (at most 10).
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      const at = Number(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'presence_at'")
          .one().value,
      );
      const alarm = (await state.storage.getAlarm()) ?? 0;
      expect(alarm).toBe(nextTick(at + PRESENCE_REFRESH_MS - ROOM_TICK_MS));
      expect(alarm - at).toBeGreaterThan(5 * 60_000);
      expect(alarm - at).toBeLessThanOrEqual(10 * 60_000);
    });

    // The room stops refreshing (its DO went away without a close): the SpaceDO forgets it.
    const { client: tab } = await subscribe(spaceId, USERS.member2.id);
    await runInDurableObject(space, (_, state) => {
      state.storage.sql.exec('UPDATE room_presence SET updated_at = 0');
    });
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(await nextOf(tab, roomId)).toEqual({ roomId, voice: [], live: [] });
  });
});

describe('access', () => {
  it('shows a restricted room only to managers and holders of a grant', async () => {
    const spaceId = await newSpace();
    const open = await newRoomIn(spaceId);
    const secret = await newRoomIn(spaceId, 'restricted');
    await env.DB.prepare(
      `INSERT INTO room_access (room_id, user_id, can_view, can_stream, granted_by, granted_at)
       VALUES (?, ?, 1, 0, ?, ?)`,
    )
      .bind(secret, USERS.member2.id, USERS.owner.id, Date.now())
      .run();
    const { client: member } = await subscribe(spaceId, USERS.member1.id);
    const { client: granted } = await subscribe(spaceId, USERS.member2.id);
    const { client: admin } = await subscribe(spaceId, USERS.admin.id);

    const { client: owner } = await Client.join(secret, USERS.owner.id);
    await owner.request('voice.join', {});
    const { client: guest } = await Client.join(open, USERS.guest1.id);
    await guest.request('voice.join', {});

    expect((await nextOf(admin, secret)).voice).toHaveLength(1);
    expect((await nextOf(granted, secret)).voice).toHaveLength(1);
    expect((await nextOf(member, open)).voice).toHaveLength(1);
    await sleep(1_200);
    expect(member.drainAll('space.presence.updated')).toEqual([]);
    // Snapshots filter the same way.
    const rooms = async (user: string) =>
      (await subscribe(spaceId, user)).presence.rooms.map((r) => r.roomId).sort();
    expect(await rooms(USERS.member1.id)).toEqual([open]);
    expect(await rooms(USERS.owner.id)).toEqual([open, secret].sort());

    // A grant (PUT .../access) reaches the member's open socket as a fresh snapshot.
    expect(
      await rest('PUT', `/rooms/${secret}/access/${USERS.member1.id}`, USERS.owner.id, {}),
    ).toBe(200);
    const fresh = await member.take('space.presence', (m: Message) => m.id === undefined);
    expect(fresh.payload.rooms.map((r) => r.roomId).sort()).toEqual([open, secret].sort());
    // ...and removing it hides the room again.
    expect(
      await rest('DELETE', `/rooms/${secret}/access/${USERS.member1.id}`, USERS.owner.id),
    ).toBe(204);
    const hidden = await member.take('space.presence', (m: Message) => m.id === undefined);
    expect(hidden.payload.rooms.map((r) => r.roomId)).toEqual([open]);
  });

  it('hides a room that becomes restricted and closes a removed member with 4003', async () => {
    const spaceId = await newSpace();
    const roomId = await newRoomIn(spaceId);
    const { client: member } = await subscribe(spaceId, USERS.member1.id);
    const { client: admin } = await subscribe(spaceId, USERS.admin.id);
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    await owner.request('voice.join', {});
    expect((await nextOf(member, roomId)).voice).toHaveLength(1);
    await nextOf(admin, roomId);

    await pastDebounce(roomId);
    expect(
      await rest('PATCH', `/rooms/${roomId}`, USERS.owner.id, { visibility: 'restricted' }),
    ).toBe(200);
    expect(await nextOf(member, roomId)).toEqual({ roomId, voice: [], live: [] });
    // The admin still sees it, so a visibility change alone sends it nothing new.
    expect((await subscribe(spaceId, USERS.admin.id)).presence.rooms).toHaveLength(1);

    expect(
      await rest('DELETE', `/spaces/${spaceId}/members/${USERS.member1.id}`, USERS.owner.id),
    ).toBe(204);
    expect(await member.take('error')).toMatchObject({ payload: { code: 'forbidden' } });
    expect((await member.closed).code).toBe(4003);
  });
});
