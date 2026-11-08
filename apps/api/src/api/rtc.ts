// SPDX-License-Identifier: AGPL-3.0-only
import { type IceServersResponse, Preset, VideoCodec } from '@openlive/protocol';
import { isBrowserPreset } from '@openlive/usage';
import { Hono } from 'hono';
import { z } from 'zod';
import { canJoinVoiceAs } from '../auth/can';
import { roomAccess } from '../room/access';
import { STREAM_ONLY } from '../room/capabilities';
import type { ConnectContext, RtcResult } from '../room/types';
import { Realtime, realtimeConfig } from '../rtc/realtime';
import { ApiError } from '../errors';
import { noteSpace } from '../metrics/errors';
import { isJpeg, THUMBNAIL_KIND_HEADER, THUMBNAIL_MAX_BYTES } from '../room/thumbnails';
import { instanceQuota } from '../usage/quota';
import { type AppEnv, authenticate, body, type Ctx } from './context';
import { id } from './schemas';

// The SFU proxy (docs/PROTOCOL.md 11.2). Each route authenticates
// (cookie or device token), runs the same room access check as the room socket, applies the
// checks that need D1, and hands the rest to the room's RoomDO, which owns the room's SFU
// sessions and makes every Realtime call. The app token and TURN key never leave the Worker.

export const rtc = new Hono<AppEnv>();

const rid = z.string().regex(/^[A-Za-z0-9]{1,16}$/);
const sessionDescription = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(65536),
});
const preset = z.enum(Preset);
const codec = z.enum(VideoCodec);

// Receivers ignore unknown fields (docs/PROTOCOL.md 1): z.object strips them.
const publishTracks = (max: number) =>
  z
    .array(
      z.object({
        mid: z.string().min(1).max(32),
        trackName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        kind: z.enum(['video', 'audio']),
        rids: z
          .array(rid)
          .max(4)
          .refine((r) => new Set(r).size === r.length)
          .optional(),
        codec: codec.optional(),
      }),
    )
    .min(1)
    .max(max)
    .refine((t) => new Set(t.map((x) => x.trackName)).size === t.length);
const publishRequest = z.object({
  sessionDescription,
  tracks: publishTracks(4),
  preset,
  maxBitrateKbps: z.number().int().min(1),
});
const browserPublishRequest = z.object({
  tabId: id,
  sessionDescription,
  tracks: publishTracks(2),
  preset,
  maxBitrateKbps: z.number().int().min(1),
});
/** A browser stream's simulcast layers: the helper's, highest first. */
const BROWSER_RIDS = ['f', 'h', 'q'];

/** Some of the browser layers, at least one, highest first. */
function browserRids(rids: readonly string[]): boolean {
  const at = rids.map((r) => BROWSER_RIDS.indexOf(r));
  return at.length > 0 && at.every((n, i) => n >= 0 && (i === 0 || n > (at[i - 1] ?? -1)));
}
const sfuSessionRequest = z.object({ sfuSessionId: id });
const publishRenegotiate = z.object({ sfuSessionId: id, sessionDescription });
const viewerSessionRequest = z.object({ sessionDescription: sessionDescription.optional() });
const subscribeRequest = z.object({
  sessionId: id,
  slotId: id,
  streamId: id,
  rid: rid.optional(),
  codec: codec.optional(),
});
const viewerRenegotiate = z.object({ sessionId: id, sessionDescription });
const layerRequest = z.object({ sessionId: id, streamId: id, rid });
const unsubscribeRequest = z.object({ sessionId: id, streamId: id });
const leaveRequest = z.object({ roomId: id, sessionId: id });
const mid = z.string().min(1).max(32);
const trackIds = (max: number) =>
  z
    .array(id)
    .min(1)
    .max(max)
    .refine((t) => new Set(t).size === t.length);
const voicePublishRequest = z.object({ sessionId: id, sessionDescription, mid });
const voiceSessionRequest = z.object({ sessionId: id });
const voiceSubscribeRequest = z.object({ sessionId: id, trackIds: trackIds(4) });
const voiceUnsubscribeRequest = z.object({ sessionId: id, trackIds: trackIds(64).optional() });
const cameraPublishRequest = voicePublishRequest;
const cameraSubscribeRequest = z.object({
  sessionId: id,
  trackIds: trackIds(4),
  rid: rid.optional(),
});
const cameraLayerRequest = z.object({ sessionId: id, trackId: id, rid });

interface Scope {
  roomId: string;
  context: ConnectContext;
  deviceId: string | null;
}

/** The caller and their room context, after the same checks as the room socket. */
async function scope(c: Ctx): Promise<Scope> {
  // The helper publishes through these routes with its device token.
  const { user, deviceId } = await authenticate(c, { allowDevice: true });
  const roomId = c.req.param('roomId') ?? '';
  if (!id.safeParse(roomId).success) throw new ApiError(404, 'room_not_found', { roomId });
  const access = await roomAccess(c.env.DB, roomId, user.id);
  if (!access.ok) {
    throw new ApiError(access.status, access.code, access.status === 401 ? undefined : { roomId });
  }
  noteSpace(c.req.raw, access.context.room.spaceId);
  const context = deviceId ? { ...access.context, deviceId } : access.context;
  return { roomId, context, deviceId };
}

/**
 * scope() for the routes that open or drive media: the room must have the stream capability
 * (403 capability_disabled). Unpublish, unsubscribe and leave stay open so clients can clean up.
 */
async function streamScope(c: Ctx): Promise<Scope> {
  const s = await scope(c);
  if (s.context.settings.capabilities?.stream === false) {
    throw new ApiError(403, 'capability_disabled', { capability: 'stream' });
  }
  return s;
}

/** scope() for the voice routes that open media: the room must have voice (since 1.10). */
async function voiceScope(c: Ctx): Promise<Scope> {
  const s = await scope(c);
  if (!canJoinVoiceAs(s.context.settings.capabilities ?? STREAM_ONLY).allowed) {
    throw new ApiError(403, 'capability_disabled', { capability: 'voice' });
  }
  return s;
}

/** scope() for the camera routes that open media: the room must have cameras (since 1.12). */
async function cameraScope(c: Ctx): Promise<Scope> {
  const s = await scope(c);
  const capabilities = s.context.settings.capabilities ?? STREAM_ONLY;
  if (!capabilities.voice || !capabilities.camera) {
    throw new ApiError(403, 'capability_disabled', { capability: 'camera' });
  }
  return s;
}

/**
 * scope() for the viewer session and its renegotiation, which carry both the streams and the
 * voice: the room needs one of the two.
 */
async function sessionScope(c: Ctx): Promise<Scope> {
  const s = await scope(c);
  const capabilities = s.context.settings.capabilities;
  if (capabilities && !capabilities.stream && !capabilities.voice) {
    throw new ApiError(403, 'capability_disabled', { capability: 'stream' });
  }
  return s;
}

/** The helper's device, or 403: only paired helpers publish. */
function helperOf(s: Scope): string {
  if (!s.deviceId) throw new ApiError(403, 'forbidden', { roomId: s.roomId });
  return s.deviceId;
}

const room = (c: Ctx, roomId: string) => c.env.ROOM.get(c.env.ROOM.idFromName(roomId));

function reply<T>(c: Ctx, result: RtcResult<T>): Response {
  if (!result.ok) return c.json(result.error, result.status);
  if (result.status === 204) return c.body(null, 204);
  return c.json(result.value, result.status);
}

/** POST /api/rtc/rooms/:roomId/ice: short-lived STUN and TURN servers. */
rtc.post('/rtc/rooms/:roomId/ice', async (c) => {
  const { context } = await scope(c);
  const config = realtimeConfig(c.env);
  if (!config) throw new ApiError(503, 'rtc_not_configured');
  c.header('Cache-Control', 'no-store');
  const iceServers = await new Realtime(config).iceServers(context.room.spaceId);
  return c.json({ iceServers } satisfies IceServersResponse);
});

/**
 * The checks every publish runs before the room (helper and browser): the permission to stream,
 * the quota brake, the preset and the bitrate. Returns whether economy mode is on.
 */
async function publishChecks(
  c: Ctx,
  s: Scope,
  input: { preset: Preset; maxBitrateKbps: number },
): Promise<boolean> {
  const { settings, permissions } = s.context;
  if (!permissions.canStream) {
    throw new ApiError(403, 'stream_permission_required', { roomId: s.roomId });
  }
  // Quota brake 4: no new streams once the quota blocks them. Brake 3
  // (economy mode) does not refuse: the answer carries the cap the publisher fits under.
  const { state: quota } = await instanceQuota(c.env.DB, new Date());
  if (quota.blockNewStreams) {
    throw new ApiError(403, 'quota_exhausted');
  }
  if (!settings.allowedPresets.includes(input.preset)) {
    throw new ApiError(403, 'preset_not_allowed', { preset: input.preset });
  }
  if (input.maxBitrateKbps > settings.maxBitrateKbps) {
    throw new ApiError(403, 'bitrate_not_allowed', { limit: settings.maxBitrateKbps });
  }
  return quota.economyMode;
}

/** POST /api/rtc/rooms/:roomId/publish (helper). */
rtc.post('/rtc/rooms/:roomId/publish', async (c) => {
  const s = await streamScope(c);
  const deviceId = helperOf(s);
  const input = await body(c, publishRequest);
  const economy = await publishChecks(c, s, input);
  // One video track per codec, an H.264 one among them (the AV1 one is its top layer).
  const videos = input.tracks.filter((t) => t.kind === 'video');
  const codecs = videos.map((t) => t.codec ?? 'h264');
  if (
    new Set(codecs).size !== codecs.length ||
    (videos.length > 0 && !codecs.includes('h264')) ||
    input.tracks.some((t) => t.kind === 'audio' && t.codec)
  ) {
    throw new ApiError(400, 'invalid_message', { path: '/tracks' });
  }
  const tracks = input.tracks.map(({ rids, codec: c, ...t }) => ({
    ...t,
    ...(rids ? { rids } : {}),
    ...(c && c !== 'h264' ? { codec: c } : {}),
  }));
  return reply(
    c,
    await room(c, s.roomId).rtcPublish(s.context, deviceId, { ...input, tracks }, economy),
  );
});

/** PUT /api/rtc/rooms/:roomId/publish/renegotiate (helper). */
rtc.put('/rtc/rooms/:roomId/publish/renegotiate', async (c) => {
  const s = await streamScope(c);
  const deviceId = helperOf(s);
  const input = await body(c, publishRenegotiate);
  return reply(
    c,
    await room(c, s.roomId).rtcPublishRenegotiate(
      s.context,
      deviceId,
      input.sfuSessionId,
      input.sessionDescription,
    ),
  );
});

/** POST /api/rtc/rooms/:roomId/unpublish (helper). */
rtc.post('/rtc/rooms/:roomId/unpublish', async (c) => {
  const s = await scope(c);
  const deviceId = helperOf(s);
  const { sfuSessionId } = await body(c, sfuSessionRequest);
  return reply(c, await room(c, s.roomId).rtcUnpublish(s.context, deviceId, sfuSessionId));
});

/** A web session, not a helper: the browser routes are the tab's own (since 1.22). */
function webOf(s: Scope): void {
  if (s.deviceId) throw new ApiError(403, 'forbidden', { roomId: s.roomId });
}

/**
 * POST /api/rtc/rooms/:roomId/browser/publish (web, since 1.22; docs/PROTOCOL.md 7.2, 11.2): a
 * desktop tab streams in place of a helper, with limited quality. The helper's checks, plus at
 * most 1080p60 and one H.264 video track (f, h, q) with at most one audio track.
 */
rtc.post('/rtc/rooms/:roomId/browser/publish', async (c) => {
  const s = await streamScope(c);
  webOf(s);
  const input = await body(c, browserPublishRequest);
  if (!isBrowserPreset(input.preset)) {
    throw new ApiError(403, 'preset_not_allowed', { preset: input.preset });
  }
  const economy = await publishChecks(c, s, input);
  const videos = input.tracks.filter((t) => t.kind === 'video');
  const audios = input.tracks.filter((t) => t.kind === 'audio');
  const video = videos[0];
  const rids = video?.rids ?? [];
  if (
    videos.length !== 1 ||
    audios.length > 1 ||
    input.tracks.some((t) => t.codec && t.codec !== 'h264') ||
    !browserRids(rids)
  ) {
    throw new ApiError(400, 'invalid_message', { path: '/tracks' });
  }
  // H.264 only: the codec is dropped, as on the helper's route.
  const tracks = input.tracks.map((t) => ({
    mid: t.mid,
    trackName: t.trackName,
    kind: t.kind,
    ...(t.rids ? { rids: t.rids } : {}),
  }));
  return reply(
    c,
    await room(c, s.roomId).rtcBrowserPublish(s.context, { ...input, tracks }, economy),
  );
});

/** PUT /api/rtc/rooms/:roomId/browser/publish/renegotiate (web, since 1.22). */
rtc.put('/rtc/rooms/:roomId/browser/publish/renegotiate', async (c) => {
  const s = await streamScope(c);
  webOf(s);
  const input = await body(c, publishRenegotiate);
  return reply(
    c,
    await room(c, s.roomId).rtcPublishRenegotiate(
      s.context,
      null,
      input.sfuSessionId,
      input.sessionDescription,
    ),
  );
});

/**
 * POST /api/rtc/rooms/:roomId/browser/unpublish (web, since 1.22): also the tab's beacon on
 * pagehide, so the body may come as text/plain. No capability check: cleanup.
 */
rtc.post('/rtc/rooms/:roomId/browser/unpublish', async (c) => {
  const s = await scope(c);
  webOf(s);
  const { sfuSessionId } = await body(c, sfuSessionRequest);
  return reply(c, await room(c, s.roomId).rtcUnpublish(s.context, null, sfuSessionId));
});

/** POST /api/rtc/rooms/:roomId/session (viewer, before any click). */
rtc.post('/rtc/rooms/:roomId/session', async (c) => {
  const s = await sessionScope(c);
  const { sessionDescription: offer } = await body(c, viewerSessionRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcViewerSession(s.context, offer ? { sessionDescription: offer } : {}),
  );
});

/** POST /api/rtc/rooms/:roomId/subscribe (viewer holding a slot). */
rtc.post('/rtc/rooms/:roomId/subscribe', async (c) => {
  const s = await streamScope(c);
  const { rid: layer, codec: wanted, ...input } = await body(c, subscribeRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcSubscribe(s.context, {
      ...input,
      ...(layer ? { rid: layer } : {}),
      ...(wanted ? { codec: wanted } : {}),
    }),
  );
});

/** PUT /api/rtc/rooms/:roomId/renegotiate (viewer). */
rtc.put('/rtc/rooms/:roomId/renegotiate', async (c) => {
  const s = await sessionScope(c);
  const input = await body(c, viewerRenegotiate);
  return reply(
    c,
    await room(c, s.roomId).rtcViewerRenegotiate(
      s.context,
      input.sessionId,
      input.sessionDescription,
    ),
  );
});

/** PUT /api/rtc/rooms/:roomId/layer (viewer): simulcast layer with tracks/update. */
rtc.put('/rtc/rooms/:roomId/layer', async (c) => {
  const s = await streamScope(c);
  const input = await body(c, layerRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcLayer(s.context, input.sessionId, input.streamId, input.rid),
  );
});

/** POST /api/rtc/rooms/:roomId/unsubscribe (viewer). */
rtc.post('/rtc/rooms/:roomId/unsubscribe', async (c) => {
  const s = await scope(c);
  const input = await body(c, unsubscribeRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcUnsubscribe(s.context, input.sessionId, input.streamId),
  );
});

/** POST /api/rtc/rooms/:roomId/voice/publish (web): the caller's microphone, audio only. */
rtc.post('/rtc/rooms/:roomId/voice/publish', async (c) => {
  const s = await voiceScope(c);
  if (s.deviceId) throw new ApiError(403, 'forbidden', { roomId: s.roomId });
  const input = await body(c, voicePublishRequest);
  return reply(c, await room(c, s.roomId).rtcVoicePublish(s.context, input));
});

/** POST /api/rtc/rooms/:roomId/voice/unpublish (web). No capability check: cleanup. */
rtc.post('/rtc/rooms/:roomId/voice/unpublish', async (c) => {
  const s = await scope(c);
  const { sessionId } = await body(c, voiceSessionRequest);
  return reply(c, await room(c, s.roomId).rtcVoiceUnpublish(s.context, sessionId));
});

/** POST /api/rtc/rooms/:roomId/voice/subscribe (web): pull 1 to 4 microphones. */
rtc.post('/rtc/rooms/:roomId/voice/subscribe', async (c) => {
  const s = await voiceScope(c);
  const input = await body(c, voiceSubscribeRequest);
  return reply(c, await room(c, s.roomId).rtcVoiceSubscribe(s.context, input));
});

/** POST /api/rtc/rooms/:roomId/voice/unsubscribe (web). No capability check: cleanup. */
rtc.post('/rtc/rooms/:roomId/voice/unsubscribe', async (c) => {
  const s = await scope(c);
  const { sessionId, trackIds: ids } = await body(c, voiceUnsubscribeRequest);
  return reply(c, await room(c, s.roomId).rtcVoiceUnsubscribe(s.context, sessionId, ids));
});

/**
 * POST /api/rtc/rooms/:roomId/camera/publish (web): the caller's camera, video only, simulcast in
 * at most two layers. Quota brake 4 blocks new cameras; the voice keeps going.
 */
rtc.post('/rtc/rooms/:roomId/camera/publish', async (c) => {
  const s = await cameraScope(c);
  if (s.deviceId) throw new ApiError(403, 'forbidden', { roomId: s.roomId });
  const input = await body(c, cameraPublishRequest);
  const { state: quota } = await instanceQuota(c.env.DB, new Date());
  return reply(
    c,
    await room(c, s.roomId).rtcCameraPublish(s.context, input, quota.blockNewStreams),
  );
});

/** POST /api/rtc/rooms/:roomId/camera/unpublish (web). No capability check: cleanup. */
rtc.post('/rtc/rooms/:roomId/camera/unpublish', async (c) => {
  const s = await scope(c);
  const { sessionId } = await body(c, voiceSessionRequest);
  return reply(c, await room(c, s.roomId).rtcCameraUnpublish(s.context, sessionId));
});

/** POST /api/rtc/rooms/:roomId/camera/subscribe (web): pull 1 to 4 cameras, the strip's layer by default. */
rtc.post('/rtc/rooms/:roomId/camera/subscribe', async (c) => {
  const s = await cameraScope(c);
  const { rid: layer, ...input } = await body(c, cameraSubscribeRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcCameraSubscribe(s.context, {
      ...input,
      ...(layer ? { rid: layer } : {}),
    }),
  );
});

/** PUT /api/rtc/rooms/:roomId/camera/layer (web): a pulled camera's layer with tracks/update. */
rtc.put('/rtc/rooms/:roomId/camera/layer', async (c) => {
  const s = await cameraScope(c);
  const input = await body(c, cameraLayerRequest);
  return reply(
    c,
    await room(c, s.roomId).rtcCameraLayer(s.context, input.sessionId, input.trackId, input.rid),
  );
});

/** POST /api/rtc/rooms/:roomId/camera/unsubscribe (web). No capability check: cleanup. */
rtc.post('/rtc/rooms/:roomId/camera/unsubscribe', async (c) => {
  const s = await scope(c);
  const { sessionId, trackIds: ids } = await body(c, voiceUnsubscribeRequest);
  return reply(c, await room(c, s.roomId).rtcCameraUnsubscribe(s.context, sessionId, ids));
});

/**
 * POST /api/rtc/leave (viewer, sendBeacon on pagehide; the body may come as text/plain). No room
 * access check: leaving must work even right after access was lost; only the session's owner can
 * close it.
 */
rtc.post('/rtc/leave', async (c) => {
  const { user } = await authenticate(c);
  const input = await body(c, leaveRequest);
  await room(c, input.roomId).rtcLeave(user.id, input.sessionId);
  return c.body(null, 204);
});

/**
 * PUT /api/rtc/rooms/:roomId/streams/:streamId/thumbnail (helper; docs/PROTOCOL.md 11.3): the
 * stream's latest snapshot, a small JPEG. The room stores it in the private R2 bucket. Since 1.22
 * a web session uploads its own browser stream's (deviceId null).
 */
rtc.put('/rtc/rooms/:roomId/streams/:streamId/thumbnail', async (c) => {
  const s = await streamScope(c);
  const deviceId = s.deviceId;
  const streamId = c.req.param('streamId');
  if (!id.safeParse(streamId).success) throw new ApiError(404, 'stream_not_found', { streamId });
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'image/jpeg') throw new ApiError(415, 'invalid_message', { path: '' });
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > THUMBNAIL_MAX_BYTES) throw new ApiError(413, 'invalid_message', { path: '' });
  const image = await c.req.arrayBuffer();
  if (image.byteLength > THUMBNAIL_MAX_BYTES) {
    throw new ApiError(413, 'invalid_message', { path: '' });
  }
  if (!isJpeg(new Uint8Array(image))) throw new ApiError(415, 'invalid_message', { path: '' });
  const placeholder = c.req.header(THUMBNAIL_KIND_HEADER)?.toLowerCase() === 'paused';
  return reply(
    c,
    await room(c, s.roomId).putThumbnail(s.context, deviceId, streamId, image, placeholder),
  );
});
