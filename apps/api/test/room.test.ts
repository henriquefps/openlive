// SPDX-License-Identifier: AGPL-3.0-only
import { PING_FRAME, PONG_FRAME } from '@openlive/protocol';
import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LEASE_MS,
  LEASE_PERSIST_MS,
  nextTick,
  OFFER_MS,
  PRESENCE_REFRESH_MS,
  ROOM_TICK_MS,
  RoomDO,
} from '../src/do/room';
import worker from '../src/index';
import { RoomStore } from '../src/room/store';
import type { Attachment } from '../src/room/types';
import {
  Client,
  newRoom,
  roomStub,
  seed,
  storeOf,
  testStream,
  upgrade,
  USERS,
} from './room-helpers';

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens a room with one test stream of the given viewer limit. */
async function roomWithStream(limit: number): Promise<{ roomId: string; streamId: string }> {
  const roomId = await newRoom();
  const streamId = 'st_1';
  await roomStub(roomId).upsertStream(testStream(streamId, limit));
  return { roomId, streamId };
}

describe('GET /ws/rooms/:roomId upgrade', () => {
  it('refuses a plain GET', async () => {
    const roomId = await newRoom();
    const res = await exports.default.fetch(`http://localhost/ws/rooms/${roomId}`);
    expect(res.status).toBe(426);
  });

  it('answers 401 unauthenticated without an identity', async () => {
    const roomId = await newRoom();
    const res = await upgrade(roomId);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthenticated' });
  });

  it('fails closed when DEV_AUTH is not "1", even with the dev header', async () => {
    const roomId = await newRoom();
    for (const DEV_AUTH of [undefined, '0', 'true']) {
      const request = new Request(`http://localhost/ws/rooms/${roomId}`, {
        headers: { Upgrade: 'websocket', 'X-Openlive-Dev-User': USERS.owner.id },
      });
      const res = await worker.fetch(request, { ...env, DEV_AUTH }, createExecutionContext());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'unauthenticated' });
    }
  });

  it('answers 401 for an unknown user, 404 for an unknown room', async () => {
    const roomId = await newRoom();
    expect((await upgrade(roomId, 'u_nobody')).status).toBe(401);
    const res = await upgrade('r_missing', USERS.owner.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'room_not_found', roomId: 'r_missing' });
  });

  it('answers 403 forbidden when can(room.view) refuses', async () => {
    const roomId = await newRoom();
    const res = await upgrade(roomId, USERS.outsider.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'forbidden', roomId });
  });

  it('answers 410 room_closed for an archived room', async () => {
    const roomId = await newRoom({ archivedAt: Date.now() - 1000 });
    const res = await upgrade(roomId, USERS.owner.id);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ code: 'room_closed', roomId });
  });
});

describe('handshake', () => {
  it('answers ping with pong through the auto-response', async () => {
    const roomId = await newRoom();
    const client = await Client.open(roomId, USERS.member1.id);
    const pong = new Promise((resolve) =>
      client.ws.addEventListener('message', (e) => resolve(e.data)),
    );
    client.raw(PING_FRAME);
    expect(await pong).toBe(PONG_FRAME);
  });

  it('welcomes with identity, permissions, room, effective settings, members and streams', async () => {
    const roomId = await newRoom({ settings: { maxViewersPerStream: 4 } });
    await roomStub(roomId).upsertStream(testStream('st_1', 10));
    const { welcome } = await Client.join(roomId, USERS.admin.id);
    expect(welcome.protocol).toEqual({ major: 1, minor: 21 });
    expect(welcome.minProtocol).toEqual({ major: 1, minor: 0 });
    expect(Math.abs(welcome.serverTime - Date.now())).toBeLessThan(5_000);
    expect(welcome.you).toMatchObject({
      userId: USERS.admin.id,
      role: 'admin',
      permissions: { canStream: true, canModerate: true },
    });
    expect(welcome.room).toEqual({
      roomId,
      spaceId: 's1',
      kind: 'fixed',
      visibility: 'space',
      name: expect.any(String),
    });
    expect(welcome.settings.maxViewersPerStream).toBe(4);
    expect(welcome.members).toEqual([
      {
        userId: USERS.admin.id,
        displayName: `Name ${USERS.admin.id}`,
        role: 'admin',
        canStream: true,
      },
    ]);
    // The stream's limit is capped by the room's.
    expect(welcome.streams).toMatchObject([{ streamId: 'st_1', viewerLimit: 4, viewerCount: 0 }]);
  });

  it('gives guests watch-only permissions', async () => {
    const roomId = await newRoom();
    const { welcome } = await Client.join(roomId, USERS.guest1.id);
    expect(welcome.you).toMatchObject({
      role: 'guest',
      permissions: { canStream: false, canModerate: false },
    });
  });

  it('requires hello first and rejects invalid frames', async () => {
    const roomId = await newRoom();
    const client = await Client.open(roomId, USERS.member1.id);
    expect(await client.request('slot.request', { streamId: 'st_1' })).toMatchObject({
      type: 'error',
      payload: { code: 'hello_required', messageType: 'slot.request' },
    });
    client.raw('not json');
    expect((await client.take('error')).payload).toEqual({ code: 'invalid_message', path: '' });
    client.raw(JSON.stringify({ type: 'slot.request', id: '9', payload: { streamId: 'bad id' } }));
    expect(await client.take('error')).toMatchObject({
      id: '9',
      payload: { code: 'invalid_message', path: '/payload/streamId' },
    });
  });

  it('answers unknown_message_type only when the message had an id', async () => {
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    client.raw(JSON.stringify({ type: 'control.request', payload: {} }));
    client.raw(JSON.stringify({ type: 'control.request', id: 'x', payload: {} }));
    expect(await client.take('error')).toMatchObject({
      id: 'x',
      payload: { code: 'unknown_message_type', messageType: 'control.request' },
    });
    expect(await client.drain('error')).toEqual([]);
  });

  it('closes with 4006 after protocol_unsupported for another major version', async () => {
    const roomId = await newRoom();
    const client = await Client.open(roomId, USERS.member1.id);
    const reply = await client.request('hello', {
      protocol: { major: 2, minor: 0 },
      client: 'web',
      clientVersion: '9.0.0',
    });
    expect(reply).toMatchObject({
      type: 'error',
      payload: {
        code: 'protocol_unsupported',
        minProtocol: { major: 1, minor: 0 },
        maxProtocol: { major: 1, minor: 21 },
      },
    });
    expect((await client.closed).code).toBe(4006);
  });

  it('replaces an older connection of the same tab (4002) without a presence change', async () => {
    const roomId = await newRoom();
    const { client: watcher } = await Client.join(roomId, USERS.owner.id);
    const { client: first } = await Client.join(roomId, USERS.member1.id, { tabId: 't_1' });
    await watcher.take('member.joined');
    const { client: second, welcome } = await Client.join(roomId, USERS.member1.id, {
      tabId: 't_1',
    });
    expect((await first.closed).code).toBe(4002);
    expect(welcome.members.map((m) => m.userId).sort()).toEqual(
      [USERS.member1.id, USERS.owner.id].sort(),
    );
    // Another tab of the same user is a separate connection.
    const { client: otherTab } = await Client.join(roomId, USERS.member1.id, { tabId: 't_2' });
    expect(await watcher.drain('member.joined')).toEqual([]);
    expect(await watcher.drain('member.left')).toEqual([]);
    second.close();
    otherTab.close();
  });

  it('replaces an older helper connection of the same device', async () => {
    const roomId = await newRoom();
    const hello = { client: 'helper', deviceId: 'd_pc' } as const;
    const { client: first } = await Client.join(roomId, USERS.member1.id, hello);
    await Client.join(roomId, USERS.member1.id, hello);
    expect((await first.closed).code).toBe(4002);
  });
});

describe('presence', () => {
  it('announces member.joined and member.left per user across clients', async () => {
    const roomId = await newRoom();
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b, welcome } = await Client.join(roomId, USERS.member2.id);
    expect(welcome.members.map((m) => m.userId).sort()).toEqual(
      [USERS.member1.id, USERS.member2.id].sort(),
    );
    expect((await a.take('member.joined')).payload.member).toEqual({
      userId: USERS.member2.id,
      displayName: `Name ${USERS.member2.id}`,
      role: 'member',
      canStream: true,
    });

    // A second connection of a present user is not a new member, and closing it is no leave.
    const { client: b2 } = await Client.join(roomId, USERS.member2.id);
    b2.close();
    expect(await a.drain('member.joined')).toEqual([]);
    expect(await a.drain('member.left')).toEqual([]);

    b.close();
    expect((await a.take('member.left')).payload).toEqual({ userId: USERS.member2.id });
  });
});

describe('viewer slots', () => {
  it('grants up to the limit, then answers viewer_limit_reached', async () => {
    const { roomId, streamId } = await roomWithStream(2);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const { client: c } = await Client.join(roomId, USERS.guest1.id);

    const grantA = await a.request('slot.request', { streamId });
    expect(grantA).toMatchObject({
      type: 'slot.granted',
      payload: { streamId, leaseMs: LEASE_MS },
    });
    if (grantA.type !== 'slot.granted') throw new Error('unreachable');
    expect(grantA.payload.expiresAt - Date.now()).toBeGreaterThan(LEASE_MS - 5_000);
    expect((await b.request('slot.request', { streamId })).type).toBe('slot.granted');

    expect(await c.request('slot.request', { streamId })).toMatchObject({
      type: 'error',
      payload: { code: 'viewer_limit_reached', streamId, limit: 2, used: 2 },
    });

    const last = (await c.drain('viewers')).at(-1)?.payload;
    expect({ ...last, viewerUserIds: last?.viewerUserIds.toSorted() }).toEqual({
      streamId,
      viewerUserIds: [USERS.member1.id, USERS.member2.id].toSorted(),
      used: 2,
      limit: 2,
      queueLength: 0,
    });
  });

  it('renews and releases its own slots only', async () => {
    const { roomId, streamId } = await roomWithStream(2);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const grant = await a.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error(`expected slot.granted, got ${grant.type}`);
    const { slotId } = grant.payload;

    expect(await a.request('slot.renew', { slotId })).toMatchObject({
      type: 'slot.renewed',
      payload: { slotId, expiresAt: expect.any(Number) },
    });
    expect(await b.request('slot.renew', { slotId })).toMatchObject({
      type: 'error',
      payload: { code: 'slot_not_found', slotId },
    });
    expect(await b.request('slot.release', { slotId })).toMatchObject({
      payload: { code: 'slot_not_found' },
    });
    expect(await a.request('slot.release', { slotId })).toMatchObject({
      type: 'slot.released',
      payload: { slotId, streamId, reason: 'released' },
    });
    expect((await b.drain('viewers')).at(-1)?.payload).toMatchObject({
      used: 0,
      viewerUserIds: [],
    });
    expect(await a.request('slot.renew', { slotId })).toMatchObject({
      payload: { code: 'slot_not_found' },
    });
  });

  it('answers stream_not_found for an unknown stream', async () => {
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    expect(await client.request('slot.request', { streamId: 'st_x' })).toMatchObject({
      payload: { code: 'stream_not_found', streamId: 'st_x' },
    });
    expect(await client.request('queue.join', { streamId: 'st_x' })).toMatchObject({
      payload: { code: 'stream_not_found', streamId: 'st_x' },
    });
  });

  it('frees a slot when the socket closes', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    await a.request('slot.request', { streamId });
    a.close();
    await b.take('member.left');
    expect((await b.request('slot.request', { streamId })).type).toBe('slot.granted');
  });

  it('releases an expired lease from the alarm', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const grant = await a.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    const stub = roomStub(roomId);
    // Nobody is queued: the alarm waits for the room tick at or after the lease deadline.
    await runInDurableObject(stub, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now());
      expect(alarm).toBeLessThanOrEqual(nextTick(grant.payload.expiresAt - 1));
      // Move the deadline into the past instead of waiting (the lease lives in memory).
      storeOf(instance).renewSlot(grant.payload.slotId, 0);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await a.take('slot.released')).payload).toEqual({
      slotId: grant.payload.slotId,
      streamId,
      reason: 'lease_expired',
    });
    expect((await a.drain('viewers')).at(-1)?.payload).toMatchObject({ used: 0 });
    // Nothing left to wait for but the presence refresh of the live stream (PROTOCOL.md 7.8).
    await runInDurableObject(stub, async (_, state) => {
      const at = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'presence_at'")
        .one();
      expect(await state.storage.getAlarm()).toBe(
        nextTick(Number(at.value) + PRESENCE_REFRESH_MS - ROOM_TICK_MS),
      );
    });
  });

  it('keeps the exact lease deadline in the alarm while someone is queued', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const grant = await a.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    await b.request('queue.join', { streamId });
    await runInDurableObject(roomStub(roomId), async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(grant.payload.expiresAt);
    });
  });

  it('releases an expired lease on the next event, before the alarm', async () => {
    const { roomId, streamId } = await roomWithStream(2);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    const grant = await a.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    await runInDurableObject(roomStub(roomId), (instance) => {
      storeOf(instance).renewSlot(grant.payload.slotId, 0);
    });
    // Any message from anyone runs the sweep.
    await b.request('slot.request', { streamId });
    expect((await a.take('slot.released')).payload).toMatchObject({ reason: 'lease_expired' });
  });

  it('confirms a held slot to the Worker (checkSlot)', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client } = await Client.join(roomId, USERS.member1.id);
    const grant = await client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    const stub = roomStub(roomId);
    expect(await stub.checkSlot(grant.payload.slotId, USERS.member1.id)).toEqual({ streamId });
    expect(await stub.checkSlot(grant.payload.slotId, USERS.member2.id)).toBeNull();
    expect(await stub.checkSlot('sl_missing', USERS.member1.id)).toBeNull();
  });
});

describe('queue', () => {
  it('serves members before guests, first come first served within a role', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: holder } = await Client.join(roomId, USERS.owner.id);
    const { client: guest } = await Client.join(roomId, USERS.guest1.id);
    const { client: member } = await Client.join(roomId, USERS.member1.id);
    const grant = await holder.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');

    expect(await guest.request('queue.join', { streamId })).toMatchObject({
      type: 'queue.position',
      payload: { streamId, position: 1, length: 1 },
    });
    expect(await member.request('queue.join', { streamId })).toMatchObject({
      type: 'queue.position',
      payload: { streamId, position: 1, length: 2 },
    });
    // The member went ahead of the guest, who is told the new position.
    expect((await guest.take('queue.position')).payload).toEqual({
      streamId,
      position: 2,
      length: 2,
    });
    expect((await holder.drain('viewers')).at(-1)?.payload.queueLength).toBe(2);

    await holder.request('slot.release', { slotId: grant.payload.slotId });
    const offer = await member.take('queue.offer');
    expect(offer.payload.expiresAt - Date.now()).toBeGreaterThan(OFFER_MS - 5_000);
    expect(await guest.drain('queue.offer')).toEqual([]);
    // The offer reserves the slot: a newcomer cannot jump the queue.
    expect(await holder.request('slot.request', { streamId })).toMatchObject({
      payload: { code: 'viewer_limit_reached', used: 1 },
    });

    expect(await member.request('queue.accept', { offerId: offer.payload.offerId })).toMatchObject({
      type: 'slot.granted',
      payload: { streamId },
    });
    expect((await guest.take('queue.position')).payload).toEqual({
      streamId,
      position: 1,
      length: 1,
    });
    // The offer is used up.
    expect(await member.request('queue.accept', { offerId: offer.payload.offerId })).toMatchObject({
      payload: { code: 'offer_not_found', offerId: offer.payload.offerId },
    });
  });

  it('passes an expired offer to the next in line', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: holder } = await Client.join(roomId, USERS.owner.id);
    const { client: first } = await Client.join(roomId, USERS.member1.id);
    const { client: second } = await Client.join(roomId, USERS.guest1.id);
    const grant = await holder.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    await first.request('queue.join', { streamId });
    await second.request('queue.join', { streamId });
    await holder.request('slot.release', { slotId: grant.payload.slotId });
    const offer = await first.take('queue.offer');

    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(offer.payload.expiresAt);
      state.storage.sql.exec('UPDATE queue SET offer_expires_at = 0 WHERE offer_id IS NOT NULL');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await first.take('queue.left')).payload).toEqual({ streamId, reason: 'offer_expired' });
    expect(await first.request('queue.accept', { offerId: offer.payload.offerId })).toMatchObject({
      payload: { code: 'offer_not_found' },
    });
    expect((await second.take('queue.position')).payload.position).toBe(1);
    const next = await second.take('queue.offer');
    expect(await second.request('queue.accept', { offerId: next.payload.offerId })).toMatchObject({
      type: 'slot.granted',
    });
  });

  it('grants at once when a slot is free, and queue.leave is idempotent', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    expect((await a.request('queue.join', { streamId })).type).toBe('slot.granted');
    expect((await b.request('queue.join', { streamId })).type).toBe('queue.position');
    expect((await b.request('queue.leave', { streamId })).type).toBe('ack');
    expect((await b.request('queue.leave', { streamId })).type).toBe('ack');
    expect((await a.drain('viewers')).at(-1)?.payload.queueLength).toBe(0);
  });

  it('offers new slots when the stream limit is raised', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    await a.request('slot.request', { streamId });
    await b.request('queue.join', { streamId });
    await roomStub(roomId).upsertStream(testStream(streamId, 2));
    expect((await b.take('queue.offer')).payload.streamId).toBe(streamId);
  });
});

describe('admin actions (RPC)', () => {
  it('kick sends kicked, closes 4004 and frees the slot', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: watcher } = await Client.join(roomId, USERS.owner.id);
    const { client: victim } = await Client.join(roomId, USERS.guest1.id);
    expect((await victim.request('slot.request', { streamId })).type).toBe('slot.granted');
    await watcher.request('queue.join', { streamId });

    expect(await roomStub(roomId).kick(USERS.guest1.id, 'banned')).toBe(1);
    expect((await victim.take('kicked')).payload).toEqual({ reason: 'banned' });
    expect((await victim.closed).code).toBe(4004);
    expect((await watcher.take('member.left')).payload.userId).toBe(USERS.guest1.id);
    // The freed slot goes straight to the queue.
    expect((await watcher.take('queue.offer')).payload.streamId).toBe(streamId);
    await runInDurableObject(roomStub(roomId), (_, state) => {
      const rows = state.storage.sql.exec('SELECT * FROM slots WHERE user_id = ?', USERS.guest1.id);
      expect(rows.toArray()).toEqual([]);
    });
  });

  it('closeRoom sends room.closed and closes everyone with 4005', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: a } = await Client.join(roomId, USERS.member1.id);
    const { client: b } = await Client.join(roomId, USERS.member2.id);
    await a.request('slot.request', { streamId });
    expect(await roomStub(roomId).closeRoom('ended_by_owner')).toBe(2);
    for (const c of [a, b]) {
      expect((await c.take('room.closed')).payload).toEqual({ reason: 'ended_by_owner' });
      expect((await c.closed).code).toBe(4005);
    }
    await runInDurableObject(roomStub(roomId), (_, state) => {
      expect(state.storage.sql.exec('SELECT * FROM slots').toArray()).toEqual([]);
    });
  });

  it('revokeAccess sends forbidden and closes with 4003', async () => {
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    await roomStub(roomId).revokeAccess(USERS.member1.id);
    expect((await client.take('error')).payload).toEqual({ code: 'forbidden', roomId });
    expect((await client.closed).code).toBe(4003);
  });

  it('permissionsChanged updates the connection and the member list', async () => {
    const roomId = await newRoom();
    const { client: guest } = await Client.join(roomId, USERS.guest1.id);
    const { client: other } = await Client.join(roomId, USERS.owner.id);
    await roomStub(roomId).permissionsChanged(USERS.guest1.id, {
      role: 'guest',
      permissions: { canStream: true, canModerate: false },
    });
    expect((await guest.take('permissions.changed')).payload.you).toMatchObject({
      userId: USERS.guest1.id,
      role: 'guest',
      permissions: { canStream: true, canModerate: false },
    });
    expect((await other.take('member.updated')).payload.member).toMatchObject({
      userId: USERS.guest1.id,
      canStream: true,
    });
  });

  it('setExpiry announces room.expiring and the alarm closes the room when it passes', async () => {
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    const stub = roomStub(roomId);
    const expiresAt = Date.now() + 600_000;
    await stub.setExpiry(expiresAt);
    expect((await client.take('room.expiring')).payload).toEqual({ expiresAt });
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
    });
    // An expiry in the past schedules the alarm in the past, and workerd may run it on its own
    // before the test gets to it (runDurableObjectAlarm then finds none and returns false). Either
    // way the alarm, not setExpiry, closes the room; the test only nudges it if it is still due.
    await stub.setExpiry(Date.now() - 1);
    await client.take('room.expiring');
    await runDurableObjectAlarm(stub);
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'expired' });
    expect((await client.closed).code).toBe(4005);
  });

  it('the alarm closes the room once a future expiry passes', async () => {
    const roomId = await newRoom();
    const { client } = await Client.join(roomId, USERS.member1.id);
    const stub = roomStub(roomId);
    const expiresAt = Date.now() + 600_000;
    await stub.setExpiry(expiresAt);
    await client.take('room.expiring');
    // Deterministic: the alarm stays scheduled in the future, and the stored expiry is moved into
    // the past behind its back, as if the ten minutes had gone by.
    await runInDurableObject(stub, async (_, state) => {
      const store = new RoomStore(state.storage.sql);
      const room = store.room();
      if (!room) throw new Error('room not stored');
      store.setRoom({ ...room, expiresAt: Date.now() - 1 });
      expect(await state.storage.getAlarm()).toBe(expiresAt);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'expired' });
    expect((await client.closed).code).toBe(4005);
  });
});

describe('leases in memory', () => {
  it('renews without writing until the stored expiry is LEASE_PERSIST_MS behind', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client } = await Client.join(roomId, USERS.member1.id);
    const grant = await client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    const { slotId } = grant.payload;
    const stored = () =>
      runInDurableObject(roomStub(roomId), (_, state) =>
        state.storage.sql
          .exec<{ expires_at: number }>('SELECT expires_at FROM slots WHERE slot_id = ?', slotId)
          .one(),
      );
    const first = (await stored()).expires_at;
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + 30_000);
    const renewed = await client.request('slot.renew', { slotId });
    if (renewed.type !== 'slot.renewed') throw new Error('expected slot.renewed');
    expect(renewed.payload.expiresAt).toBe(t0 + 30_000 + LEASE_MS);
    // In memory only: the row still has the grant's expiry, the Worker sees the renewal.
    expect((await stored()).expires_at).toBe(first);
    expect(await roomStub(roomId).checkSlot(slotId, USERS.member1.id)).toEqual({ streamId });
    // Renewing on time up to LEASE_PERSIST_MS after the grant: then the row is written.
    for (let t = 60_000; t < LEASE_PERSIST_MS; t += 60_000) {
      vi.spyOn(Date, 'now').mockImplementation(() => t0 + t);
      await client.request('slot.renew', { slotId });
      expect((await stored()).expires_at).toBe(first);
    }
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + LEASE_PERSIST_MS);
    await client.request('slot.renew', { slotId });
    expect((await stored()).expires_at).toBe(t0 + LEASE_PERSIST_MS + LEASE_MS);
  });

  it('after an eviction, gives a recently stored lease a full lease from the wake-up', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client } = await Client.join(roomId, USERS.member1.id);
    const grant = await client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    const stub = roomStub(roomId);
    await evictDurableObject(stub);
    // Past the stored expiry, but within LEASE_PERSIST_MS of it: the holder may have renewed in
    // memory before the eviction, so the slot survives with a fresh lease.
    const wake = grant.payload.expiresAt + 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wake);
    expect(await stub.checkSlot(grant.payload.slotId, USERS.member1.id)).toEqual({ streamId });
    await runInDurableObject(stub, (instance) => {
      expect(storeOf(instance).slot(grant.payload.slotId)?.expires_at).toBe(wake + LEASE_MS);
    });
    // Renewing goes on as before.
    expect(await client.request('slot.renew', { slotId: grant.payload.slotId })).toMatchObject({
      type: 'slot.renewed',
    });
  });

  it('after an eviction, lets a lease stored long ago expire', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client } = await Client.join(roomId, USERS.member1.id);
    const grant = await client.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    const stub = roomStub(roomId);
    await evictDurableObject(stub);
    // The holder stopped renewing long ago (a socket that died without a close): every wake-up
    // must not extend it again.
    const wake = grant.payload.expiresAt + LEASE_PERSIST_MS + 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wake);
    expect(await stub.checkSlot(grant.payload.slotId, USERS.member1.id)).toBeNull();
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.setAlarm(wake - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await client.take('slot.released')).payload).toMatchObject({
      slotId: grant.payload.slotId,
      reason: 'lease_expired',
    });
  });
});

describe('hibernation safety', () => {
  it('keeps slots, queue and identity in storage and attachments, not in memory', async () => {
    const { roomId, streamId } = await roomWithStream(1);
    const { client: holder, welcome } = await Client.join(roomId, USERS.member1.id);
    const { client: queued } = await Client.join(roomId, USERS.guest1.id);
    const grant = await holder.request('slot.request', { streamId });
    if (grant.type !== 'slot.granted') throw new Error('expected slot.granted');
    await queued.request('queue.join', { streamId });
    const stub = roomStub(roomId);

    await runInDurableObject(stub, async (_, state) => {
      const slots = state.storage.sql.exec('SELECT slot_id, user_id FROM slots').toArray();
      expect(slots).toEqual([{ slot_id: grant.payload.slotId, user_id: USERS.member1.id }]);
      const queue = state.storage.sql.exec('SELECT user_id, priority FROM queue').toArray();
      expect(queue).toEqual([{ user_id: USERS.guest1.id, priority: 1 }]);
      const attachments = state
        .getWebSockets()
        .map((ws) => ws.deserializeAttachment() as Attachment);
      expect(attachments.find((a) => a.userId === USERS.member1.id)).toMatchObject({
        connectionId: welcome.you.connectionId,
        role: 'member',
        hello: { client: 'web' },
      });
      // A brand-new instance on the same state sees the same room.
      const fresh = new RoomDO(state, env);
      expect(await fresh.checkSlot(grant.payload.slotId, USERS.member1.id)).toEqual({ streamId });
    });

    // Real hibernation: the instance is torn down, the sockets stay open.
    await evictDurableObject(stub);

    expect(await holder.request('slot.renew', { slotId: grant.payload.slotId })).toMatchObject({
      type: 'slot.renewed',
    });
    await holder.request('slot.release', { slotId: grant.payload.slotId });
    const offer = await queued.take('queue.offer');
    expect(await queued.request('queue.accept', { offerId: offer.payload.offerId })).toMatchObject({
      type: 'slot.granted',
    });
    holder.close();
    expect((await queued.take('member.left')).payload.userId).toBe(USERS.member1.id);
  });
});
