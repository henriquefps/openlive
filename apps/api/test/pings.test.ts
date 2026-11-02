// SPDX-License-Identifier: AGPL-3.0-only
import type { PointerStyle } from '@openlive/protocol';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PING_BURST } from '../src/do/room';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import { TokenBuckets } from '../src/room/pings';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, roomStub, seed, testStream, USERS } from './room-helpers';

// Visual pointer pings (docs/PROTOCOL.md 7.9): stream.setPings and pointer.ping in the RoomDO.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const STYLE: PointerStyle = { color: 'olive', shape: 'ring' };
const OWNER_HELPER = { client: 'helper', deviceId: 'd_owner' } as const;

/** A room with the owner's test stream (device d_owner), with or without pingOverlay. */
async function roomWithStream(
  extra: { pingOverlay?: boolean; pings?: boolean; paused?: boolean } = {},
): Promise<{ roomId: string; streamId: string }> {
  const roomId = await newRoom();
  const streamId = 'st_1';
  await roomStub(roomId).upsertStream({ ...testStream(streamId, 4), ...extra });
  return { roomId, streamId };
}

/** The owner's helper, a viewer with a slot (member1) and a web client without one (member2). */
async function cast(roomId: string, streamId: string) {
  const { client: helper } = await Client.join(roomId, USERS.owner.id, OWNER_HELPER);
  const { client: viewer } = await Client.join(roomId, USERS.member1.id);
  const grant = await viewer.request('slot.request', { streamId });
  expect(grant.type).toBe('slot.granted');
  const { client: other } = await Client.join(roomId, USERS.member2.id);
  return { helper, viewer, other };
}

describe('stream.announce pingOverlay', () => {
  it('copies pingOverlay to StreamInfo and starts every stream with pings off', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const who = { user: USERS.member1.id, device: 'd_pc1' };
    const pub = await exports.default.fetch(`http://localhost/api/rtc/rooms/${roomId}/publish`, {
      method: 'POST',
      headers: {
        [DEV_USER_HEADER]: who.user,
        [DEV_DEVICE_HEADER]: who.device,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionDescription: offer,
        tracks: [{ mid: '0', trackName: 'video', kind: 'video' }],
        preset: 'game',
        maxBitrateKbps: 9000,
      }),
    });
    expect(pub.status).toBe(201);
    const { sfuSessionId } = await pub.json<{ sfuSessionId: string }>();
    const { client: helper } = await Client.join(roomId, who.user, {
      client: 'helper',
      deviceId: who.device,
    });
    const started = await helper.request('stream.announce', {
      sfuSessionId,
      source: { kind: 'screen', label: 'Screen 1' },
      preset: 'game',
      hasAudio: false,
      tracks: [{ name: 'video', kind: 'video' }],
      pingOverlay: true,
    });
    if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
    expect(started.payload.stream.pingOverlay).toBe(true);
    expect(started.payload.stream.pings).toBeUndefined();
  });

  it('leaves pingOverlay absent for a helper that does not announce it', async () => {
    const { roomId } = await roomWithStream();
    const { welcome } = await Client.join(roomId, USERS.member1.id);
    expect(welcome.streams[0]?.pingOverlay).toBeUndefined();
    expect(welcome.streams[0]?.pings).toBeUndefined();
  });
});

describe('stream.setPings', () => {
  it('lets the streamer turn pings on and off; everyone gets stream.updated', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true });
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    const { client: web } = await Client.join(roomId, USERS.member1.id);

    expect(await owner.request('stream.setPings', { streamId, enabled: true })).toMatchObject({
      type: 'ack',
    });
    expect((await web.take('stream.updated')).payload.stream).toMatchObject({
      streamId,
      pings: true,
      pingOverlay: true,
    });
    await owner.request('stream.setPings', { streamId, enabled: false });
    expect((await web.take('stream.updated')).payload.stream.pings).toBe(false);
  });

  it('refuses someone else, a helper, an unknown stream, and enabling without pingOverlay', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true });
    const { client: other } = await Client.join(roomId, USERS.admin.id);
    expect(await other.request('stream.setPings', { streamId, enabled: true })).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    const { client: helper } = await Client.join(roomId, USERS.owner.id, OWNER_HELPER);
    expect(await helper.request('stream.setPings', { streamId, enabled: true })).toMatchObject({
      payload: { code: 'forbidden' },
    });
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    expect(
      await owner.request('stream.setPings', { streamId: 'st_x', enabled: true }),
    ).toMatchObject({ payload: { code: 'stream_not_found', streamId: 'st_x' } });

    const plain = await roomWithStream();
    const { client: owner2 } = await Client.join(plain.roomId, USERS.owner.id);
    expect(
      await owner2.request('stream.setPings', { streamId: plain.streamId, enabled: true }),
    ).toMatchObject({ payload: { code: 'forbidden' } });
    // Turning off is always allowed.
    expect(
      await owner2.request('stream.setPings', { streamId: plain.streamId, enabled: false }),
    ).toMatchObject({ type: 'ack' });
  });
});

describe('pointer.ping', () => {
  it('forwards to the publishing helper only, with the sender name, and replies nothing', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { helper, viewer, other } = await cast(roomId, streamId);
    const { client: ownerWeb } = await Client.join(roomId, USERS.owner.id);

    viewer.send('pointer.ping', { streamId, x: 0.25, y: 0.75, style: STYLE });
    expect((await helper.take('pointer.pinged')).payload).toEqual({
      streamId,
      userId: USERS.member1.id,
      name: `Name ${USERS.member1.id}`,
      x: 0.25,
      y: 0.75,
      style: STYLE,
    });
    expect(await viewer.drain('error')).toEqual([]);
    expect(await viewer.drain('pointer.pinged')).toEqual([]);
    expect(await other.drain('pointer.pinged')).toEqual([]);
    expect(await ownerWeb.drain('pointer.pinged')).toEqual([]);
  });

  it('refuses a web client without a slot and the streamer on their own stream', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { other } = await cast(roomId, streamId);
    const ping = { streamId, x: 0.5, y: 0.5, style: STYLE };
    expect(await other.request('pointer.ping', ping)).toMatchObject({
      type: 'error',
      payload: { code: 'forbidden' },
    });
    const { client: ownerWeb } = await Client.join(roomId, USERS.owner.id);
    expect(await ownerWeb.request('pointer.ping', ping)).toMatchObject({
      payload: { code: 'forbidden' },
    });
    expect(await other.request('pointer.ping', { ...ping, streamId: 'st_x' })).toMatchObject({
      payload: { code: 'stream_not_found' },
    });
  });

  it('answers pings_disabled while the streamer has not allowed pings', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true });
    const { viewer } = await cast(roomId, streamId);
    expect(
      await viewer.request('pointer.ping', { streamId, x: 0.5, y: 0.5, style: STYLE }),
    ).toMatchObject({ type: 'error', payload: { code: 'pings_disabled', streamId } });
  });

  it('drops pings silently while the stream is paused', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { helper, viewer } = await cast(roomId, streamId);
    await roomStub(roomId).upsertStream({
      ...testStream(streamId, 4),
      pingOverlay: true,
      pings: true,
      paused: true,
      pauseReason: 'privacy_curtain',
    });
    viewer.send('pointer.ping', { streamId, x: 0.1, y: 0.1, style: STYLE });
    expect(await viewer.drain('error')).toEqual([]);
    await roomStub(roomId).upsertStream({
      ...testStream(streamId, 4),
      pingOverlay: true,
      pings: true,
    });
    viewer.send('pointer.ping', { streamId, x: 0.9, y: 0.9, style: STYLE });
    // The first one the helper gets is the one sent after the pause.
    expect((await helper.take('pointer.pinged')).payload.x).toBe(0.9);
  });

  it('rejects coordinates outside 0..1 and styles outside the closed lists', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { viewer } = await cast(roomId, streamId);
    const bad = [
      { streamId, x: 1.2, y: 0.5, style: STYLE },
      { streamId, x: 0.5, y: -0.1, style: STYLE },
      { streamId, x: 0.5, y: 0.5, style: { color: 'black', shape: 'ring' } },
      { streamId, x: 0.5, y: 0.5, style: { color: 'olive', shape: 'arrow' } },
      { streamId, x: 0.5, y: 0.5 },
    ];
    for (const payload of bad) {
      viewer.raw(JSON.stringify({ type: 'pointer.ping', id: 'bad', payload }));
      expect((await viewer.take('error')).payload.code).toBe('invalid_message');
    }
  });

  it('rate-limits per user: a burst of 8, then rate_limited with retryAfterMs', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { helper, viewer } = await cast(roomId, streamId);
    const ping = { streamId, x: 0.5, y: 0.5, style: STYLE };
    for (let i = 0; i < PING_BURST; i++) viewer.send('pointer.ping', ping);
    const limited = await viewer.request('pointer.ping', ping);
    expect(limited).toMatchObject({ type: 'error', payload: { code: 'rate_limited' } });
    if (limited.type !== 'error') throw new Error('unreachable');
    expect(limited.payload.retryAfterMs).toBeGreaterThan(0);
    expect(limited.payload.retryAfterMs).toBeLessThanOrEqual(250);
    for (let i = 0; i < PING_BURST; i++) await helper.take('pointer.pinged');
  });

  it('forgets the setting with the stream when it ends', async () => {
    const { roomId, streamId } = await roomWithStream({ pingOverlay: true, pings: true });
    const { client: owner } = await Client.join(roomId, USERS.owner.id);
    expect(await owner.request('stream.terminate', { streamId })).toMatchObject({ type: 'ack' });
    expect(await owner.request('stream.setPings', { streamId, enabled: true })).toMatchObject({
      payload: { code: 'stream_not_found' },
    });
  });
});

describe('TokenBuckets', () => {
  it('allows the burst, then refills at the rate', () => {
    const b = new TokenBuckets(4, 8);
    for (let i = 0; i < 8; i++) expect(b.take('u', 1_000)).toBe(0);
    expect(b.take('u', 1_000)).toBe(250);
    expect(b.take('u', 1_100)).toBe(150);
    expect(b.take('u', 1_250)).toBe(0);
    expect(b.take('u', 1_250)).toBeGreaterThan(0);
    // Another key has its own bucket.
    expect(b.take('v', 1_250)).toBe(0);
  });
});
