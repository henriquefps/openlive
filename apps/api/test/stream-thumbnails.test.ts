// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from './api-helpers';
import { FakeSfu, offer } from './fake-sfu';
import { Client, newRoom, seed, USERS } from './room-helpers';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';
import { THUMBNAIL_MAX_BYTES, thumbnailKey } from '../src/room/thumbnails';

// Stream thumbnails (docs/PROTOCOL.md 11.3): the helper's upload, the
// private serving with a room access check on every request, and the deletes on pause and end.

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

interface Who {
  user: string;
  device?: string;
}

function headersOf(who: Who, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [DEV_USER_HEADER]: who.user,
    ...(who.device ? { [DEV_DEVICE_HEADER]: who.device } : {}),
    ...extra,
  };
}

async function rest(method: string, path: string, who: Who, body?: unknown) {
  const res = await exports.default.fetch(`http://localhost/api${path}`, {
    method,
    headers: headersOf(who, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
}

/** A tiny "JPEG": the SOI marker and filler, enough for the type check. */
function jpeg(fill = 1, size = 64): Uint8Array {
  const out = new Uint8Array(size).fill(fill);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  return out;
}

function upload(
  roomId: string,
  streamId: string,
  who: Who,
  image: Uint8Array,
  extra: Record<string, string> = {},
) {
  return exports.default.fetch(
    `http://localhost/api/rtc/rooms/${roomId}/streams/${streamId}/thumbnail`,
    {
      method: 'PUT',
      headers: headersOf(who, { 'Content-Type': 'image/jpeg', ...extra }),
      body: image,
    },
  );
}

function view(streamId: string, who: Who, extra: Record<string, string> = {}) {
  return exports.default.fetch(`http://localhost/api/streams/${streamId}/thumbnail`, {
    headers: headersOf(who, extra),
  });
}

function gone(streamId: string): Promise<void> {
  return vi.waitFor(async () => {
    expect(await env.THUMBNAILS.head(thumbnailKey(streamId))).toBeNull();
  });
}

const HELPER = { user: USERS.member1.id, device: 'd_th1' };

async function liveStream(roomId: string, who: { user: string; device: string } = HELPER) {
  const pub = await rest('POST', `/rtc/rooms/${roomId}/publish`, who, {
    sessionDescription: offer,
    tracks: [{ mid: '0', trackName: 'video', kind: 'video', rids: ['f', 'h', 'q'] }],
    preset: 'game',
    maxBitrateKbps: 9000,
  });
  expect(pub.status).toBe(201);
  const { client: helper } = await Client.join(roomId, who.user, {
    client: 'helper',
    deviceId: who.device,
  });
  const started = await helper.request('stream.announce', {
    sfuSessionId: pub.body.sfuSessionId,
    source: { kind: 'screen', label: 'Screen 1' },
    preset: 'game',
    hasAudio: false,
    tracks: [{ name: 'video', kind: 'video', rids: ['f', 'h', 'q'] }],
  });
  if (started.type !== 'stream.started') throw new Error(JSON.stringify(started));
  return { helper, streamId: started.payload.stream.streamId };
}

describe('upload (helper)', () => {
  it('stores the JPEG privately and announces its version with stream.updated', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const { client: web } = await Client.join(roomId, USERS.member2.id);

    const res = await upload(roomId, streamId, HELPER, jpeg());
    expect(res.status).toBe(204);
    const updated = await web.take('stream.updated');
    expect(updated.payload.stream.thumbnailAt).toEqual(expect.any(Number));
    const object = await env.THUMBNAILS.get(thumbnailKey(streamId));
    expect(object?.customMetadata).toEqual({ roomId, streamId });
    expect(object?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('takes only the device that streams, a JPEG, small, and not too often', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const status = async (p: Promise<Response>) => {
      const r = await p;
      return { status: r.status, body: await r.json() };
    };

    // A web session (which uploads only its own browser stream's since 1.22), another device of
    // the same user, another user's device: not this stream.
    expect(await status(upload(roomId, streamId, { user: HELPER.user }, jpeg()))).toMatchObject({
      status: 404,
      body: { code: 'stream_not_found', streamId },
    });
    expect(
      await status(upload(roomId, streamId, { user: HELPER.user, device: 'd_other' }, jpeg())),
    ).toMatchObject({ status: 404, body: { code: 'stream_not_found', streamId } });
    expect(
      await status(upload(roomId, streamId, { user: USERS.member2.id, device: 'd_m2' }, jpeg())),
    ).toMatchObject({ status: 404, body: { code: 'stream_not_found' } });
    expect(
      await status(upload(roomId, streamId, { user: USERS.outsider.id, device: 'd_o' }, jpeg())),
    ).toMatchObject({ status: 403, body: { code: 'forbidden' } });

    // Type and size.
    expect(
      await status(upload(roomId, streamId, HELPER, jpeg(), { 'Content-Type': 'image/png' })),
    ).toMatchObject({ status: 415, body: { code: 'invalid_message' } });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    expect(await status(upload(roomId, streamId, HELPER, png))).toMatchObject({ status: 415 });
    expect(
      await status(upload(roomId, streamId, HELPER, jpeg(1, THUMBNAIL_MAX_BYTES + 1))),
    ).toMatchObject({ status: 413, body: { code: 'invalid_message' } });

    // Rate limit: one per 4 s.
    expect((await upload(roomId, streamId, HELPER, jpeg())).status).toBe(204);
    const again = await status(upload(roomId, streamId, HELPER, jpeg(2)));
    expect(again).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    const retry = (again.body as { retryAfterMs: number }).retryAfterMs;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(4000);
  });

  it('drops the last frame when the stream pauses and takes only the placeholder', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { helper, streamId } = await liveStream(roomId);
    const { client: web } = await Client.join(roomId, USERS.member2.id);
    expect((await upload(roomId, streamId, HELPER, jpeg())).status).toBe(204);
    await web.take('stream.updated');

    expect(
      (
        await helper.request('stream.update', {
          streamId,
          paused: true,
          pauseReason: 'privacy_curtain',
        })
      ).type,
    ).toBe('ack');
    const paused = await web.take('stream.updated');
    expect(paused.payload.stream.paused).toBe(true);
    expect(paused.payload.stream.thumbnailAt).toBeUndefined();
    // Deleted at the end of the same event, right after the ack.
    await gone(streamId);
    expect((await view(streamId, { user: USERS.member2.id })).status).toBe(404);

    // A real frame during the curtain is refused; the placeholder is taken.
    const refused = await upload(roomId, streamId, HELPER, jpeg());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: 'stream_paused', streamId });
    const placeholder = await upload(roomId, streamId, HELPER, jpeg(9), {
      'X-Openlive-Thumbnail': 'paused',
    });
    expect(placeholder.status).toBe(204);
    expect((await web.take('stream.updated')).payload.stream.thumbnailAt).toEqual(
      expect.any(Number),
    );
  });

  it('deletes the thumbnail when the stream ends', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { helper, streamId } = await liveStream(roomId);
    expect((await upload(roomId, streamId, HELPER, jpeg())).status).toBe(204);
    expect(await env.THUMBNAILS.head(thumbnailKey(streamId))).not.toBeNull();
    expect((await helper.request('stream.end', { streamId })).type).toBe('ack');
    await gone(streamId);
  });
});

describe('serving', () => {
  it('needs room access on every request, never a slot, and answers private with an ETag', async () => {
    new FakeSfu().install();
    const roomId = await newRoom();
    const { streamId } = await liveStream(roomId);
    const image = jpeg(7);
    expect((await upload(roomId, streamId, HELPER, image)).status).toBe(204);

    // A member who holds no slot sees it.
    const ok = await view(streamId, { user: USERS.guest1.id });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/jpeg');
    expect(ok.headers.get('Cache-Control')).toBe('private, max-age=10');
    const etag = ok.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(image);

    const cached = await view(streamId, { user: USERS.guest1.id }, { 'If-None-Match': etag ?? '' });
    expect(cached.status).toBe(304);
    await cached.arrayBuffer();

    // Not signed in, not a member, unknown stream: all the same 404 (or 401 without identity).
    const anonymous = await exports.default.fetch(
      `http://localhost/api/streams/${streamId}/thumbnail`,
    );
    expect(anonymous.status).toBe(401);
    await anonymous.arrayBuffer();
    const outsider = await view(streamId, { user: USERS.outsider.id });
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual({ code: 'not_found' });
    expect((await view('st_unknown', { user: USERS.member2.id })).status).toBe(404);

    // Access is checked again on each request: the room turns restricted, a member without a
    // grant loses the thumbnail at once, while the owner keeps it.
    await env.DB.prepare("UPDATE rooms SET visibility = 'restricted' WHERE id = ?")
      .bind(roomId)
      .run();
    expect((await view(streamId, { user: USERS.member2.id })).status).toBe(404);
    const owner = await view(streamId, { user: USERS.owner.id });
    expect(owner.status).toBe(200);
    await owner.arrayBuffer();
  });
});
