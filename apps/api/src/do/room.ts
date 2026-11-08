// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CameraPublishRequest,
  type CameraPublishResponse,
  CameraStopReason,
  type CameraSubscribeRequest,
  type CameraSubscribeResponse,
  type CameraTrack,
  Capability,
  CloseCode,
  ErrorCode,
  type ErrorPayload,
  encodeMessage,
  EventCode,
  KickReason,
  type LivePresence,
  type Member,
  type MessageId,
  type MessageType,
  type PayloadOf,
  parseMessage,
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
  type Permissions,
  type Preset,
  type BrowserPublishRequest,
  type PublishRequest,
  type PublishResponse,
  type QualityCap,
  QueueLeftReason,
  type RenegotiateResponse,
  type Role,
  type RoomCloseReason,
  type RoomSettings,
  type RoomVisibility,
  type SessionDescription,
  SlotReleaseReason,
  StreamEndReason,
  type StreamInfo,
  type SubscribeRequest,
  type SubscribeResponse,
  type VideoLayer,
  type ViewerSessionRequest,
  type ViewerSessionResponse,
  VideoCodec,
  VoiceLeftReason,
  type VoiceParticipant,
  type VoicePresence,
  type VoicePublishRequest,
  type VoicePublishResponse,
  type VoiceSubscribeRequest,
  type VoiceSubscribeResponse,
  type VoiceTrack,
  type You,
} from '@openlive/protocol';
import {
  type Av1Mode,
  CAMERA_LAYERS,
  codecKbps,
  DEFAULT_MAX_CAMERAS,
  ECONOMY_CAP,
  isBrowserPreset,
  overheads,
} from '@openlive/usage';
import { DurableObject } from 'cloudflare:workers';
import {
  canJoinVoiceAs,
  canModerateCameraAs,
  canModerateVoiceAs,
  canReadChatAs,
  canSpeakAs,
  canUseCameraAs,
  canWriteChatAs,
} from '../auth/can';
import { platformSettings } from '../db/platform';
import { metricsDataset, writeStreamEnd } from '../metrics/points';
import { STREAM_ONLY } from '../room/capabilities';
import { CHAT_MESSAGES, type ChatErase, RoomChat } from '../room/chat-room';
import { CONNECT_PATH, decodeConnectContext } from '../room/connect';
import {
  accrue,
  addJoin,
  av1ModeFor,
  flushAmounts,
  layerKbps,
  rateKey,
  type StreamRates,
} from '../room/meter';
import { DEFAULT_MAX_VOICE_PARTICIPANTS } from '../room/settings';
import {
  type CameraTrackRow,
  LEASE_MS,
  type PublishedTrackRow,
  queuePriority,
  RoomStore,
  type SlotRow,
  type VoiceParticipantRow,
  type VoiceTrackRow,
} from '../room/store';
import { TokenBuckets } from '../room/pings';
import { THUMBNAIL_MIN_GAP_MS, thumbnailKey } from '../room/thumbnails';
import type {
  Attachment,
  ConnectContext,
  RoomStream,
  RtcResult,
  UserStreamInfo,
} from '../room/types';
import { SessionQueue } from '../rtc/queue';
import { chunks, Realtime, realtimeConfig, SfuError, type SfuTrack } from '../rtc/realtime';
import { mediaKindOfMid, sendRidsOfMid } from '../rtc/sdp';
import type { RoomPresenceUpdate } from '../space/types';
import { recordEstimate } from '../usage/meter';
import { brakeUntil, Dormancy } from './limits-brake';
import { instanceQuota } from '../usage/quota';
import {
  BREAKER_CLOSE_CODE,
  BREAKER_CLOSE_REASON,
  CircuitBreaker,
  guardRpc,
  refusedUpgrade,
} from './breaker';

export { LEASE_MS, LEASE_PERSIST_MS } from '../room/store';
/**
 * The room's tick: the periodic work that tolerates being late runs on this grid
 * of wall-clock time, so one alarm (one setAlarm, a write) serves all of it: the meter flush, the
 * presence refresh, and the lease sweep. With nobody queued, an expired lease is released by the
 * next event in the room (another viewer's renewal, at most 30 s later) or by the tick, so the
 * renewals never move the alarm; with someone queued, the alarm keeps the exact deadline.
 */
export const ROOM_TICK_MS = 5 * 60_000;
/** The next tick strictly after `t`. */
export const nextTick = (t: number): number => (Math.floor(t / ROOM_TICK_MS) + 1) * ROOM_TICK_MS;
/** Time a queued viewer has to accept a free slot. */
export const OFFER_MS = 30_000;
/** A stream survives its helper's socket for this long. */
export const HELPER_GRACE_MS = 15_000;
/** How long a stream's start is kept for the app's summary (PROTOCOL.md 11.7). */
export const STREAM_STARTS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Time between POST .../publish and stream.announce before the publication is closed. */
export const ANNOUNCE_MS = 60_000;
/** Viewer SFU sessions kept per user per room (tabs); the oldest is forgotten beyond this. */
export const MAX_VIEWER_SESSIONS = 8;
/** At most one presence push to the SpaceDO per this long; later changes wait (PROTOCOL.md 7.8). */
export const PRESENCE_DEBOUNCE_MS = 1_000;
/**
 * A non-empty presence summary is pushed again at most this long after the last push (on the
 * first room tick past half of it), so the SpaceDO knows it is current.
 */
export const PRESENCE_REFRESH_MS = 10 * 60_000;
/** A failed presence push is retried after this long. */
export const PRESENCE_RETRY_MS = 5_000;
/**
 * A deadline still due after the alarm handled it (a bug: the handler did not clear it) is retried
 * this long later instead of at once, so it can never spin the alarm in a hot loop.
 */
export const STUCK_DEADLINE_RETRY_MS = 60_000;
/**
 * When to set the alarm for the earliest deadline `next`. From an alarm handled at `handledAt`
 * (its start), a deadline at or before that time is one the handler did not clear: retried
 * STUCK_DEADLINE_RETRY_MS after `now` instead of at once. One that fell due while the handler ran
 * is kept as it is.
 */
export const alarmTarget = (next: number, handledAt: number | null, now: number): number =>
  handledAt !== null && next <= handledAt ? now + STUCK_DEADLINE_RETRY_MS : next;
/** Pointer pings per second per user, and the burst (PROTOCOL.md 7.9). */
export const PING_RATE_PER_S = 4;
export const PING_BURST = 8;
const MAX_FRAME_CHARS = 512 * 1024;
const MIN_PROTOCOL = { major: 1, minor: 0 } as const;

/** Client messages of the stream capability: refused in a room without it. */
const STREAM_MESSAGES: ReadonlySet<MessageType> = new Set<MessageType>([
  'slot.request',
  'slot.renew',
  'slot.release',
  'queue.join',
  'queue.accept',
  'queue.leave',
  'stream.announce',
  'stream.update',
  'stream.end',
  'stream.setViewerLimit',
  'stream.terminate',
  'stream.setPings',
  'pointer.ping',
]);
/** Client messages of the voice channel (docs/PROTOCOL.md 7.5): web only, and need voice. */
const VOICE_MESSAGES: ReadonlySet<MessageType> = new Set<MessageType>([
  'voice.join',
  'voice.leave',
  'voice.state',
  'voice.serverMute',
  'voice.kick',
  'voice.cameraOff',
]);
/** Close reasons after which the room never opens again (its chat is deleted). */
const ROOM_ENDS: ReadonlySet<RoomCloseReason> = new Set<RoomCloseReason>([
  'expired',
  'ended_by_owner',
  'archived',
  'deleted',
]);
const METER_DUE_KEY = 'meter_due';
/** The quick room expiry the alarm already closed the room for: it is never handled again. */
const EXPIRED_KEY = 'expired_at';
const QUOTA_BLOCKED_KEY = 'quota_blocked_at';
/** 1 while the instance's quota state is in economy mode (brake 3); absent otherwise. */
const ECONOMY_KEY = 'economy';
/** The last summary pushed to the SpaceDO (JSON) and when (the next push is due in memory). */
const PRESENCE_SENT_KEY = 'presence_sent';
const PRESENCE_AT_KEY = 'presence_at';

const userTag = (userId: string) => `u:${userId}`;
const connTag = (connectionId: string) => `c:${connectionId}`;
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

const CLOSE_REASONS: Record<number, string> = {
  [CloseCode.Normal]: 'normal',
  [CloseCode.Unauthenticated]: 'unauthenticated',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.Forbidden]: 'forbidden',
  [CloseCode.Kicked]: 'kicked',
  [CloseCode.RoomClosed]: 'room_closed',
  [CloseCode.ProtocolUnsupported]: 'protocol_unsupported',
  [BREAKER_CLOSE_CODE]: BREAKER_CLOSE_REASON,
};

/** A role or permission change pushed by the Worker after D1 changed. */
export interface PermissionChange {
  role: Role;
  permissions: Permissions;
}

type Failure = Extract<RtcResult<never>, { ok: false }>;
const fail = (status: Failure['status'], error: ErrorPayload): Failure => ({
  ok: false,
  status,
  error,
});
const okResult = <T>(value: T, status: 200 | 201 | 204 = 200): RtcResult<T> => ({
  ok: true,
  status,
  value,
});

/**
 * One instance per room (idFromName(roomId)). Implements the room channel of docs/PROTOCOL.md:
 * handshake, presence, viewer slots and the priority queue, the stream lifecycle, and (as RPC for
 * the Worker's REST routes) the SFU proxy: the room owns every Realtime session it creates, so
 * calls on one session are serialized here (rtc/queue.ts).
 *
 * Hibernation: connection identity lives in each socket's attachment, everything else in the
 * DO's SQLite (room/store.ts), and every deadline (leases, offers, announce, helper grace, meter
 * flush, quick room expiry) is served by one alarm set to the earliest. Only work in flight lives
 * in instance fields, and nothing is in flight while the object hibernates.
 *
 * Every event starts with begin() (the usage meter accrues up to now) and ends with finish()
 * (SFU tracks of what ended are closed, the meter flushes if a stream ended, the alarm is set).
 *
 * Besides fetch (the WebSocket upgrade), the public methods are RPC for the Worker only; clients
 * never reach them (the DO is not routable from outside, only through the ROOM binding).
 */
export class RoomDO extends DurableObject<Env> {
  private readonly store: RoomStore;
  private readonly sfuQueue = new SessionQueue();
  /** SFU tracks to close at the end of the current event: session id → mids. */
  private pendingCloses: { sessionId: string; mids: string[] }[] = [];
  /** A stream ended during this event: flush the meter at its end. */
  private flushPending = false;
  /** Publishes between their limit check and their stored publication. */
  private publishing = 0;
  /** Users whose browser publish is between its checks and its stored publication. */
  private readonly browserPublishing = new Set<string>();
  /** Users whose camera publish is between its limit check and its stored track. */
  private readonly cameraPublishing = new Set<string>();
  /** R2 thumbnails to delete at the end of the current event (streams that ended or paused). */
  private pendingThumbnailDeletes: string[] = [];
  /** The text chat (room/chat-room.ts). */
  private readonly chat: RoomChat;
  /**
   * The rates (meter.rateKey) the stored meter row accrues at: the meter is written when they
   * change. Null on a fresh instance until the first event, whose rates are the stored ones.
   */
  private savedRateKey: string | null = null;
  /**
   * When the presence summary is next pushed (debounce, retry or refresh). In memory only: every
   * event's finish() recomputes it from the stored last push (pushPresence).
   */
  private presenceDue: number | null = null;
  /** Pointer ping rate limit per user (PROTOCOL.md 7.9). In memory: hibernation refills it. */
  private readonly pingBuckets = new TokenBuckets(PING_RATE_PER_S, PING_BURST);
  /** Under the limits brake: no sockets, no alarm until it releases. */
  private readonly dormancy = new Dormancy();
  /** Stops this object if it goes wild, see do/breaker.ts. */
  private readonly breaker: CircuitBreaker;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage.sql);
    this.breaker = new CircuitBreaker(this, ctx, env, {
      object: 'RoomDO',
      scope: () => {
        const room = this.store.room();
        return { spaceId: room?.spaceId ?? null, roomId: room?.roomId ?? null };
      },
      metricId: () => this.store.room()?.roomId ?? '',
    });
    this.chat = new RoomChat(ctx.storage.sql, {
      settings: () => this.store.settings(),
      send,
      broadcastWeb: (type, payload, except) => this.broadcastWeb(type, payload, except),
      sendError: (ws, error, id) => this.sendError(ws, error, id),
      forbidden: (ws, id) => this.forbidden(ws, id),
      roleOf: (userId) => {
        const ws = this.userSockets(userId)[0];
        return ws ? attachmentOf(ws).role : null;
      },
      recordAuthor: (userId) => this.recordChatAuthor(userId),
      notifyMention: (userId, authorId) => this.notifyMention(userId, authorId),
    });
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json({ ok: true, object: 'RoomDO' });
    }
    if (!this.breaker.enter('request')) return refusedUpgrade();
    if (pathname !== CONNECT_PATH) {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    // The Worker forwards a connect only while the limits brake is off.
    this.dormancy.wake();
    const context = decodeConnectContext(request);
    if (!context || request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ code: ErrorCode.InvalidMessage, path: '' }, { status: 400 });
    }
    this.begin();
    this.refresh(context);

    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: Attachment = {
      connectionId: newId('c'),
      userId: context.userId,
      displayName: context.displayName,
      role: context.role,
      permissions: context.permissions,
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
      ...(context.appTokenId ? { appTokenId: context.appTokenId } : {}),
      ...(context.avatarUrl ? { avatarUrl: context.avatarUrl } : {}),
    };
    this.ctx.acceptWebSocket(server, [
      userTag(attachment.userId),
      connTag(attachment.connectionId),
    ]);
    server.serializeAttachment(attachment);
    this.breaker.connected();
    await this.finish();
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- WebSocket events ---

  override async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    const me = attachmentOf(ws);
    if (me.closing) return;
    if (await this.brakeStops()) return;
    if (!this.breaker.enter('message') || !this.breaker.socketMessage(me.connectionId)) {
      // Closed once, with the usual clean-up; its later frames stop at `closing` above.
      this.begin();
      this.disconnect(ws, BREAKER_CLOSE_CODE);
      await this.finish();
      return;
    }
    if (typeof frame !== 'string' || frame.length > MAX_FRAME_CHARS) {
      this.sendError(ws, { code: ErrorCode.InvalidMessage, path: '' });
      return;
    }
    const parsed = parseMessage(frame);
    if (!parsed.ok) {
      // Unknown types are ignored unless they asked for a reply (PROTOCOL.md section 1).
      if (parsed.error.code === ErrorCode.UnknownMessageType && !parsed.id) return;
      this.sendError(ws, parsed.error, parsed.id);
      return;
    }
    this.begin();
    const msg = parsed.message;
    if (!me.hello) {
      if (msg.type === 'hello') this.onHello(ws, me, msg.payload, msg.id);
      else this.sendError(ws, { code: ErrorCode.HelloRequired, messageType: msg.type }, msg.id);
      await this.finish();
      return;
    }
    if (STREAM_MESSAGES.has(msg.type) && !this.streamCapability()) {
      // A room without the stream capability has no stream messages (capability_disabled).
      this.sendError(
        ws,
        { code: ErrorCode.CapabilityDisabled, capability: Capability.Stream },
        msg.id,
      );
      await this.finish();
      return;
    }
    if (VOICE_MESSAGES.has(msg.type)) {
      if (me.hello.client !== 'web') {
        this.forbidden(ws, msg.id);
        await this.finish();
        return;
      }
      // Leaving always works, so a client can clean up after the capability went away.
      if (msg.type !== 'voice.leave' && !this.voiceCapability()) {
        this.sendError(
          ws,
          { code: ErrorCode.CapabilityDisabled, capability: Capability.Voice },
          msg.id,
        );
        await this.finish();
        return;
      }
      if (msg.type === 'voice.cameraOff' && !this.cameraCapability()) {
        this.sendError(
          ws,
          { code: ErrorCode.CapabilityDisabled, capability: Capability.Camera },
          msg.id,
        );
        await this.finish();
        return;
      }
    }
    // The text chat (docs/PROTOCOL.md 7.6): web only, and needs text.
    if (CHAT_MESSAGES.has(msg.type) && (me.hello.client !== 'web' || !this.textCapability())) {
      if (me.hello.client !== 'web') this.forbidden(ws, msg.id);
      else {
        this.sendError(
          ws,
          { code: ErrorCode.CapabilityDisabled, capability: Capability.Text },
          msg.id,
        );
      }
      await this.finish();
      return;
    }
    switch (msg.type) {
      case 'chat.send':
      case 'chat.edit':
      case 'chat.delete':
      case 'chat.history':
      case 'chat.read':
        await this.chat.onMessage(ws, me, msg);
        break;
      case 'voice.join':
        this.onVoiceJoin(ws, me, msg.payload, msg.id);
        break;
      case 'voice.leave':
        this.onVoiceLeave(ws, me, msg.id);
        break;
      case 'voice.state':
        this.onVoiceState(ws, me, msg.payload, msg.id);
        break;
      case 'voice.serverMute':
        this.onVoiceModerate(ws, me, msg.payload.userId, msg.id, msg.payload.muted);
        break;
      case 'voice.kick':
        this.onVoiceModerate(ws, me, msg.payload.userId, msg.id);
        break;
      case 'voice.cameraOff':
        this.onCameraOff(ws, me, msg.payload.userId, msg.id);
        break;
      case 'slot.request':
        this.onSlotRequest(ws, me, msg.payload.streamId, msg.id);
        break;
      case 'slot.renew':
        this.onSlotRenew(ws, me, msg.payload.slotId, msg.id);
        break;
      case 'slot.release':
        this.onSlotRelease(ws, me, msg.payload.slotId, msg.id);
        break;
      case 'queue.join':
        this.onQueueJoin(ws, me, msg.payload.streamId, msg.id);
        break;
      case 'queue.accept':
        this.onQueueAccept(ws, me, msg.payload.offerId, msg.id);
        break;
      case 'queue.leave':
        this.onQueueLeave(ws, me, msg.payload.streamId, msg.id);
        break;
      case 'stream.announce':
        this.onStreamAnnounce(ws, me, msg.payload, msg.id);
        break;
      case 'stream.update':
        this.onStreamUpdate(ws, me, msg.payload, msg.id);
        break;
      case 'stream.end':
        this.onStreamEnd(ws, me, msg.payload.streamId, msg.id);
        break;
      case 'stream.setViewerLimit':
        this.onSetViewerLimit(ws, me, msg.payload, msg.id);
        break;
      case 'stream.terminate':
        this.onStreamTerminate(ws, me, msg.payload.streamId, msg.id);
        break;
      case 'stream.setPings':
        this.onSetPings(ws, me, msg.payload, msg.id);
        break;
      case 'pointer.ping':
        this.onPointerPing(ws, me, msg.payload, msg.id);
        break;
      case 'hello':
        // Only the first message may be hello.
        this.sendError(ws, { code: ErrorCode.InvalidMessage, path: '/type' }, msg.id);
        break;
      default:
        // Valid but not served by the room (server-to-client types and hub messages): same rule
        // as an unknown type.
        if (msg.id) {
          this.sendError(ws, { code: ErrorCode.UnknownMessageType, messageType: msg.type }, msg.id);
        }
    }
    await this.finish();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.begin();
    this.disconnect(ws, CloseCode.Normal);
    await this.finish();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.begin();
    this.disconnect(ws, CloseCode.Normal);
    await this.finish();
  }

  // --- Alarm: leases, offers, announce deadlines, helper grace, meter, quick room expiry ---

  override async alarm(): Promise<void> {
    // Alarms run without the Worker: the limits brake is checked here too.
    if (await this.brakeStops()) return;
    // Tripped: nothing is done and nothing re-arms the alarm (the trip deleted it).
    if (!this.breaker.enter('alarm')) return;
    this.begin();
    const now = Date.now();
    const expiresAt = this.pendingExpiry();
    if (expiresAt !== null && expiresAt <= now) {
      this.close('expired');
      // Handled once: the stored room keeps its expiresAt, which is no longer a deadline.
      this.store.setNumber(EXPIRED_KEY, expiresAt);
      await this.finish(now);
      return;
    }
    this.expire(now, true);
    for (const streamId of this.store.graceExpired(now)) {
      this.endStream(streamId, StreamEndReason.HelperDisconnected);
    }
    for (const pub of this.store.expiredPublications(now)) {
      this.closeLater(
        pub.sfu_session_id,
        pub.tracks.map((t) => t.mid),
      );
      this.store.deletePublication(pub.sfu_session_id);
    }
    this.chat.sweep(now);
    await this.finish(now);
  }

  /**
   * Whether the limits brake is engaged (the isolate's cached copy): then the room goes dormant,
   * closing every socket with 1013 and deleting its alarm, and the event is not handled.
   */
  private async brakeStops(): Promise<boolean> {
    if (this.dormancy.active) return true;
    const until = await brakeUntil(this.env.DB);
    if (until === null) return false;
    await this.dormancy.sleep(this.ctx, until);
    return true;
  }

  /** The limits brake engaged (the cron): sockets closed with 1013, no alarm. */
  async brakeSleep(until: number): Promise<number> {
    return this.dormancy.sleep(this.ctx, until);
  }

  /** The quick room's expiry while still to come; null for a fixed room or once it closed it. */
  private pendingExpiry(): number | null {
    const expiresAt = this.store.room()?.expiresAt;
    if (expiresAt === undefined || this.store.getNumber(EXPIRED_KEY) === expiresAt) return null;
    return expiresAt;
  }

  /** Releases expired leases and, with `offers`, expired queue offers. */
  private expire(now: number, offers: boolean): void {
    const slots = this.store.expiredSlots(now);
    const expiredOffers = offers ? this.store.expiredOffers(now) : [];
    const streams = new Set([...slots, ...expiredOffers].map((r) => r.stream_id));
    for (const streamId of streams) {
      const before = this.store.positions(streamId);
      for (const slot of slots.filter((s) => s.stream_id === streamId)) {
        this.store.deleteSlot(slot.slot_id);
        this.sendTo(slot.connection_id, 'slot.released', {
          slotId: slot.slot_id,
          streamId,
          reason: SlotReleaseReason.LeaseExpired,
        });
      }
      for (const entry of expiredOffers.filter((o) => o.stream_id === streamId)) {
        this.store.dequeue(entry.seq);
        this.sendTo(entry.connection_id, 'queue.left', {
          streamId,
          reason: QueueLeftReason.OfferExpired,
        });
      }
      this.settle(streamId, before);
    }
  }

  // --- RPC for the Worker: admin actions ---

  /**
   * Registers or updates a stream directly, without a helper (tests, and the synthetic
   * streams). Changing viewerLimit re-runs the queue at once.
   */
  async upsertStream(stream: RoomStream): Promise<void> {
    this.begin();
    const before = this.store.positions(stream.streamId);
    this.store.upsertStream(stream);
    this.settle(stream.streamId, before);
    await this.finish();
  }

  /** Whether `slotId` is a live slot held by `userId`. */
  async checkSlot(slotId: string, userId: string): Promise<{ streamId: string } | null> {
    const slot = this.store.slot(slotId);
    if (!slot || slot.user_id !== userId || slot.expires_at <= Date.now()) return null;
    return { streamId: slot.stream_id };
  }

  /** Removal, ban or demotion out of the room: kicked, then close 4004. */
  async kick(userId: string, reason: KickReason = KickReason.Removed): Promise<number> {
    this.begin();
    this.endStreamsOf((s) => s.userId === userId, StreamEndReason.PermissionRevoked);
    this.leaveVoice(userId, VoiceLeftReason.Removed);
    this.chat.forget(userId);
    const sockets = this.userSockets(userId);
    for (const ws of sockets) {
      send(ws, 'kicked', { reason });
      this.disconnect(ws, CloseCode.Kicked);
    }
    await this.finish();
    return sockets.length;
  }

  /**
   * The user's live streams here, as metadata for the platform admin: never the
   * source's label (a window title) or anything else from the content.
   */
  async streamsOf(userId: string): Promise<UserStreamInfo[]> {
    return this.store
      .streams()
      .filter((s) => s.userId === userId)
      .map((s) => ({
        streamId: s.streamId,
        preset: s.preset,
        sourceKind: s.source.kind,
        startedAt: s.startedAt,
        viewerCount: this.streamInfo(s).viewerCount,
      }));
  }

  /** Lost view access to a restricted room while still in the space: error forbidden, close 4003. */
  async revokeAccess(userId: string): Promise<number> {
    this.begin();
    this.endStreamsOf((s) => s.userId === userId, StreamEndReason.PermissionRevoked);
    this.leaveVoice(userId, VoiceLeftReason.Removed);
    this.chat.forget(userId);
    const roomId = this.store.room()?.roomId;
    const sockets = this.userSockets(userId);
    for (const ws of sockets) {
      this.sendError(ws, { code: ErrorCode.Forbidden, ...(roomId ? { roomId } : {}) });
      this.disconnect(ws, CloseCode.Forbidden);
    }
    await this.finish();
    return sockets.length;
  }

  /**
   * A paired device was revoked (docs/PROTOCOL.md 11.1): its sockets get error session_expired
   * and close with 4001, its streams end at once and its pending publications are closed.
   */
  async revokeDevice(deviceId: string): Promise<number> {
    this.begin();
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => attachmentOf(ws).deviceId === deviceId && !attachmentOf(ws).closing);
    for (const ws of sockets) {
      this.sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    this.endStreamsOf((s) => s.deviceId === deviceId, StreamEndReason.HelperDisconnected);
    for (const pub of this.store.allPublications()) {
      if (pub.device_id !== deviceId || pub.stream_id !== null) continue;
      this.closeLater(
        pub.sfu_session_id,
        pub.tracks.map((t) => t.mid),
      );
      this.store.deletePublication(pub.sfu_session_id);
    }
    await this.finish();
    return sockets.length;
  }

  /**
   * An app token was revoked (docs/PROTOCOL.md 11.6): its sockets get error session_expired and
   * close with 4001, which also takes the app out of the voice channel.
   */
  async revokeApp(appTokenId: string): Promise<number> {
    this.begin();
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => attachmentOf(ws).appTokenId === appTokenId && !attachmentOf(ws).closing);
    for (const ws of sockets) {
      this.sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    await this.finish();
    return sockets.length;
  }

  /** The room was closed, archived, deleted or expired: room.closed, then close 4005 for all. */
  async closeRoom(reason: RoomCloseReason): Promise<number> {
    this.begin();
    const n = this.close(reason);
    await this.finish();
    return n;
  }

  /** Schedules or moves a quick room's expiry; connected clients get room.expiring. */
  /**
   * The room's visibility changed in D1 (PATCH /api/rooms/:id): the space sidebar hides or shows
   * its presence on the next push.
   */
  async visibilityChanged(visibility: RoomVisibility): Promise<void> {
    this.begin();
    const room = this.store.room();
    if (room) this.store.setRoom({ ...room, visibility });
    await this.finish();
  }

  async setExpiry(expiresAt: number): Promise<void> {
    const room = this.store.room();
    if (!room) return;
    this.store.setRoom({ ...room, expiresAt });
    this.broadcast('room.expiring', { expiresAt });
    await this.scheduleAlarm(null);
  }

  /** A user's role or permissions changed in D1: tell their connections and everyone else. */
  async permissionsChanged(userId: string, change: PermissionChange): Promise<void> {
    this.begin();
    const sockets = this.userSockets(userId);
    for (const ws of sockets) {
      const a = { ...attachmentOf(ws), role: change.role, permissions: change.permissions };
      ws.serializeAttachment(a);
      send(ws, 'permissions.changed', { you: this.you(a) });
    }
    const first = sockets[0];
    if (first) this.broadcast('member.updated', { member: member(attachmentOf(first)) });
    // A new role may take away the right to speak (a member demoted to guest).
    if (first) this.enforceSpeak(attachmentOf(first));
    // ... and the right to a camera (a member demoted to guest where guests have none).
    if (first) this.enforceCameras();
    // Queue priority follows the role.
    const affected = new Set(this.store.setUserPriority(userId, queuePriority(change.role)));
    for (const streamId of affected) this.notifyPositions(streamId, new Map());
    // A revoked stream permission also ends the user's streams (PROTOCOL.md 7.1).
    if (!change.permissions.canStream) {
      this.endStreamsOf((s) => s.userId === userId, StreamEndReason.PermissionRevoked, true);
    }
    await this.finish();
  }

  /**
   * The room's effective settings changed in D1 (room, space or platform level): store them, end
   * the live streams if the stream capability is now off (as when the room closes), and tell the
   * web tabs with room.updated.
   */
  async settingsChanged(settings: RoomSettings): Promise<void> {
    this.begin();
    const before = new Map(
      this.present().map(({ ws, a }) => [ws, JSON.stringify(this.you(a).permissions)]),
    );
    this.store.setSettings(settings);
    if (!this.streamCapability()) {
      this.endStreamsOf(() => true, StreamEndReason.RoomClosed, true);
    }
    // Voice off: everyone leaves, with the reason.
    if (!this.voiceCapability()) {
      for (const p of this.store.voiceParticipants()) {
        this.leaveVoice(p.user_id, VoiceLeftReason.CapabilityDisabled);
      }
    }
    // guestsCanSpeak or the capability changed what web connections may do in voice.
    for (const { ws, a } of this.present()) {
      if (a.hello?.client !== 'web') continue;
      const you = this.you(a);
      if (before.get(ws) !== JSON.stringify(you.permissions)) {
        send(ws, 'permissions.changed', { you });
      }
    }
    for (const p of this.store.voiceParticipants()) {
      const a = this.voiceAttachment(p);
      if (a) this.enforceSpeak(a);
    }
    this.enforceCameras();
    // Web tabs only: the web ships with the Worker, a helper may predate 1.9 (PROTOCOL.md 1).
    const frame = encodeMessage('room.updated', { settings });
    for (const { ws, a } of this.present()) {
      if (a.hello?.client === 'web') sendFrame(ws, frame);
    }
    await this.finish();
  }

  /** Flushes the usage meter to D1 now (the alarm does it every room tick while live). */
  async flushUsage(): Promise<void> {
    this.begin();
    this.flushPending = true;
    await this.finish();
  }

  /** Unread chat messages for a user, for the space's room list (docs/PROTOCOL.md 7.6). */
  async chatUnread(userId: string): Promise<number> {
    return this.textCapability() ? this.chat.unread(userId) : 0;
  }

  /** Unread messages and the ones among them that mention the user (PROTOCOL.md 7.6). */
  async chatCounts(userId: string): Promise<{ unread: number; mentions: number }> {
    return this.textCapability() ? this.chat.counts(userId) : { unread: 0, mentions: 0 };
  }

  /**
   * The account was deleted (DELETE /api/admin/users/:userId): its chat messages here are deleted
   * (everyone connected hears chat.deleted) or anonymized. Returns how many.
   */
  async eraseChatAuthor(userId: string, mode: ChatErase): Promise<number> {
    this.begin();
    const n = this.chat.erase(userId, mode);
    await this.finish();
    return n;
  }

  /** The ids of the live streams, for the scheduled sweep of leftover thumbnails. */
  async liveStreamIds(): Promise<string[]> {
    return this.store.streams().map((s) => s.streamId);
  }

  /**
   * PUT .../streams/:streamId/thumbnail (docs/PROTOCOL.md 11.3): stores the helper's JPEG in R2
   * and tells the room its new version. The Worker checked the device, the room access, the type
   * and the size; the stream must be this device's, and while it is paused only the placeholder is
   * taken (nothing of the screen leaves during the curtain).
   */
  async putThumbnail(
    context: ConnectContext,
    deviceId: string | null,
    streamId: string,
    image: ArrayBuffer,
    placeholder: boolean,
  ): Promise<RtcResult<null>> {
    this.begin();
    this.refresh(context);
    try {
      const stream = this.store.stream(streamId);
      // A helper's own stream, or (deviceId null, since 1.22) the caller's own browser stream.
      const owned =
        stream &&
        stream.userId === context.userId &&
        (deviceId === null ? stream.origin === 'browser' : stream.deviceId === deviceId);
      if (!stream || !owned) {
        return fail(404, { code: ErrorCode.StreamNotFound, streamId });
      }
      if (stream.paused && !placeholder) {
        return fail(409, { code: ErrorCode.StreamPaused, streamId });
      }
      const since = Date.now() - (stream.thumbnailAt ?? 0);
      if (since < THUMBNAIL_MIN_GAP_MS) {
        return fail(429, {
          code: ErrorCode.RateLimited,
          retryAfterMs: THUMBNAIL_MIN_GAP_MS - since,
        });
      }
      const key = thumbnailKey(streamId);
      await this.env.THUMBNAILS.put(key, image, {
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { roomId: context.room.roomId, streamId },
      });
      // Other events ran while R2 stored it: the stream may have ended or paused meanwhile.
      const after = this.store.stream(streamId);
      if (!after || (after.paused && !placeholder)) {
        this.pendingThumbnailDeletes.push(key);
        return after
          ? fail(409, { code: ErrorCode.StreamPaused, streamId })
          : fail(404, { code: ErrorCode.StreamNotFound, streamId });
      }
      const next: RoomStream = { ...after, thumbnailAt: Date.now() };
      this.store.upsertStream(next);
      this.broadcast('stream.updated', { stream: this.streamInfo(next) });
      return okResult(null, 204);
    } finally {
      await this.finish();
    }
  }

  // --- RPC for the Worker: the SFU proxy (docs/PROTOCOL.md 11.2) ---
  //
  // The Worker authenticates, runs the room access check and the limits that need D1 (permission,
  // quota, preset, bitrate), then calls these with the caller's ConnectContext. Everything that
  // needs the room's state, and every Realtime call, happens here.

  /** POST .../publish: sessions/new, then tracks/new with the helper's offer. */
  async rtcPublish(
    context: ConnectContext,
    deviceId: string,
    req: PublishRequest,
    economy = false,
  ): Promise<RtcResult<PublishResponse>> {
    return this.rpc(context, async (rt, now) => {
      // The Worker just read the quota state: brake 3 applies from this publish on.
      this.setEconomy(economy);
      const full = this.streamLimitRefusal(context, now);
      if (full) return full;
      if (this.store.streams().some((s) => s.deviceId === deviceId)) {
        return fail(409, { code: ErrorCode.HelperBusy, deviceId });
      }
      return this.publishSession(rt, now, context, { deviceId, tabId: null }, req);
    });
  }

  /**
   * POST .../browser/publish (since 1.22, docs/PROTOCOL.md 7.2): the helper's publish for a web
   * tab. The Worker checked the permission, quota, preset (at most 1080p60), bitrate and tracks;
   * here the room's stream limit and one browser stream per user in the room. The publication
   * gets a device id of its own, which names no paired device, and remembers the tab.
   */
  async rtcBrowserPublish(
    context: ConnectContext,
    req: BrowserPublishRequest,
    economy = false,
  ): Promise<RtcResult<PublishResponse>> {
    return this.rpc(context, async (rt, now) => {
      this.setEconomy(economy);
      const full = this.streamLimitRefusal(context, now);
      if (full) return full;
      const mine = this.store
        .browserPublicationsOf(context.userId)
        .filter((p) => p.stream_id !== null || (p.announce_by ?? 0) > now);
      if (mine.length > 0 || this.browserPublishing.has(context.userId)) {
        return fail(409, { code: ErrorCode.BrowserStreamBusy, roomId: context.room.roomId });
      }
      this.browserPublishing.add(context.userId);
      try {
        const { tabId, ...publish } = req;
        return await this.publishSession(
          rt,
          now,
          context,
          { deviceId: newId('wb'), tabId },
          publish,
        );
      } finally {
        this.browserPublishing.delete(context.userId);
      }
    });
  }

  /** The room's stream limit, publications not announced yet and publishes in flight included. */
  private streamLimitRefusal(context: ConnectContext, now: number): Failure | null {
    const limit = context.settings.maxStreams;
    const live = this.store.streams().length;
    return live + this.store.pendingPublications(now) + this.publishing >= limit
      ? fail(409, { code: ErrorCode.StreamLimitReached, limit })
      : null;
  }

  /** sessions/new, then tracks/new with the publisher's offer, and the stored publication. */
  private async publishSession(
    rt: Realtime,
    now: number,
    context: ConnectContext,
    owner: { deviceId: string; tabId: string | null },
    req: PublishRequest,
  ): Promise<RtcResult<PublishResponse>> {
    this.publishing += 1;
    try {
      const session = await rt.newSession();
      const sfuSessionId = session.sessionId;
      await this.recordSession(
        sfuSessionId,
        context,
        owner.tabId === null ? 'publish' : 'browser_publish',
        owner.tabId === null ? owner.deviceId : null,
      );
      const res = await this.sfuQueue.run(sfuSessionId, () =>
        rt.newTracks(
          sfuSessionId,
          req.tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
          req.sessionDescription,
        ),
      );
      if (res.sessionDescription?.type !== 'answer') throw new SfuError('body', 200, null);
      const tracks: PublishedTrackRow[] = req.tracks.map((t) => ({
        name: t.trackName,
        kind: t.kind,
        mid: res.tracks?.find((r) => r.trackName === t.trackName)?.mid ?? t.mid,
        ...(t.rids?.length ? { rids: t.rids } : {}),
        ...(t.codec ? { codec: t.codec } : {}),
      }));
      this.store.insertPublication({
        sfu_session_id: sfuSessionId,
        user_id: context.userId,
        device_id: owner.deviceId,
        tab_id: owner.tabId,
        tracks,
        max_bitrate_kbps: req.maxBitrateKbps,
        created_at: now,
        announce_by: Date.now() + ANNOUNCE_MS,
        stream_id: null,
      });
      return okResult(
        {
          sfuSessionId,
          sessionDescription: res.sessionDescription,
          tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.name })),
          announceWithinMs: ANNOUNCE_MS,
          ...(this.qualityCap() ? { qualityCap: ECONOMY_CAP } : {}),
        },
        201,
      );
    } finally {
      this.publishing -= 1;
    }
  }

  /** PUT .../publish/renegotiate (a helper's device), or .../browser/publish/renegotiate (null). */
  async rtcPublishRenegotiate(
    context: ConnectContext,
    deviceId: string | null,
    sfuSessionId: string,
    sessionDescription: SessionDescription,
  ): Promise<RtcResult<RenegotiateResponse>> {
    return this.rpc(context, async (rt) => {
      const pub = this.store.publication(sfuSessionId);
      if (!pub || !ownsPublication(pub, context.userId, deviceId)) {
        return fail(404, { code: ErrorCode.SfuSessionNotFound, sessionId: sfuSessionId });
      }
      const res = await this.sfuQueue.run(sfuSessionId, () =>
        rt.renegotiate(sfuSessionId, sessionDescription),
      );
      return okResult(res.sessionDescription ? { sessionDescription: res.sessionDescription } : {});
    });
  }

  /**
   * POST .../unpublish (a helper's device) or .../browser/unpublish (null): closes every track of
   * the publication and ends its stream.
   */
  async rtcUnpublish(
    context: ConnectContext,
    deviceId: string | null,
    sfuSessionId: string,
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const pub = this.store.publication(sfuSessionId);
      if (!pub) return okResult(null, 204);
      if (!ownsPublication(pub, context.userId, deviceId)) {
        return fail(404, { code: ErrorCode.SfuSessionNotFound, sessionId: sfuSessionId });
      }
      if (pub.stream_id) this.endStream(pub.stream_id, StreamEndReason.EndedByStreamer);
      else
        this.closeLater(
          sfuSessionId,
          pub.tracks.map((t) => t.mid),
        );
      this.store.deletePublication(sfuSessionId);
      return okResult(null, 204);
    });
  }

  /** POST .../session: the viewer's SFU session in this room, opened before any click. */
  async rtcViewerSession(
    context: ConnectContext,
    req: ViewerSessionRequest,
  ): Promise<RtcResult<ViewerSessionResponse>> {
    return this.rpc(context, async (rt) => {
      const [iceServers, session] = await Promise.all([
        rt.iceServers(context.room.spaceId),
        rt.newSession(req.sessionDescription),
      ]);
      await this.recordSession(session.sessionId, context, 'view', null);
      this.store.insertViewerSession(session.sessionId, context.userId, Date.now());
      const sessions = this.store.viewerSessionsOf(context.userId);
      for (const old of sessions.slice(0, Math.max(0, sessions.length - MAX_VIEWER_SESSIONS))) {
        this.forgetViewerSession(old);
      }
      const answer = session.sessionDescription;
      return okResult(
        {
          sessionId: session.sessionId,
          iceServers,
          ...(answer?.type === 'answer' ? { sessionDescription: answer } : {}),
        },
        201,
      );
    });
  }

  /**
   * POST .../subscribe: checks the slot, then pulls the stream's tracks onto the viewer's session
   * in one tracks/new (simulcast video with the client-side simulcast policy, and the audio).
   */
  async rtcSubscribe(
    context: ConnectContext,
    req: SubscribeRequest,
  ): Promise<RtcResult<SubscribeResponse>> {
    return this.rpc(context, async (rt, now) => {
      const { sessionId, slotId, streamId } = req;
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const slotOk = (at: number) => {
        const slot = this.store.slot(slotId);
        return (
          slot !== null &&
          slot.user_id === context.userId &&
          slot.stream_id === streamId &&
          slot.expires_at > at
        );
      };
      if (!slotOk(now)) return fail(404, { code: ErrorCode.SlotNotFound, slotId });
      const sfu = this.store.streamSfu(streamId);
      const pub = this.store.publicationOfStream(streamId);
      const stream = this.store.stream(streamId);
      if (!sfu || !pub || !stream) return fail(404, { code: ErrorCode.StreamNotFound, streamId });
      // The layers are the H.264 track's; the AV1 track is its top layer alone.
      const h264 = pulledVideo(sfu.tracks, undefined, stream.preset, context.settings);
      const rids = h264?.rids ?? [];
      if (req.rid !== undefined && rids.length > 0 && !rids.includes(req.rid)) {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/rid' });
      }
      // Economy mode starts new pulls on the middle layer (brake 3); a viewer may still ask for
      // another.
      const fallback = this.economy() ? rids[Math.min(1, rids.length - 1)] : rids[0];
      const rid = rids.length > 0 ? (req.rid ?? (fallback as string)) : null;
      const top = rid === null || rid === rids[0];
      const video = top
        ? pulledVideo(sfu.tracks, req.codec, stream.preset, context.settings)
        : h264;
      const codec = video?.codec ?? VideoCodec.H264;

      const old = this.store.subscription(sessionId, streamId);
      if (old) {
        this.store.deleteSubscription(sessionId, streamId);
        this.closeLater(
          sessionId,
          old.mids.map((m) => m.mid),
        );
        await this.drainCloses();
      }
      // The stream's audio and one of its video tracks: the viewer's codec when it may have it.
      const pulled = sfu.tracks.filter((t) => t.kind !== 'video' || t === video);
      const remote = pulled.map((t) => remoteTrack(sfu.sfu_session_id, t, rid));
      const res = await this.sfuQueue.run(sessionId, () => rt.newTracks(sessionId, remote));
      const mids = (res.tracks ?? []).flatMap((r) => {
        const t = pulled.find((x) => x.name === r.trackName);
        if (!t || !r.mid) return [];
        return [{ mid: r.mid, kind: t.kind, ...(t.codec ? { codec: t.codec } : {}) }];
      });
      // The slot may have gone while the SFU answered: undo the pull.
      if (!slotOk(Date.now()) || !this.store.streamSfu(streamId)) {
        this.closeLater(
          sessionId,
          mids.map((m) => m.mid),
        );
        return fail(404, { code: ErrorCode.SlotNotFound, slotId });
      }
      this.accrueNow();
      // A join costs the top layer's rate whatever `rid` asks: the SFU starts every new pull on
      // the top layer and steps down to the asked one over 3–4 s (measured for the hover
      // pre-pull). The seconds after that accrue at the asked layer.
      addJoin(
        this.store,
        codecKbps(
          layerKbps(pub.max_bitrate_kbps, rids, null),
          codec,
          av1ModeFor(context.settings, stream.preset),
        ),
        Date.now(),
      );
      this.store.upsertSubscription({
        session_id: sessionId,
        stream_id: streamId,
        slot_id: slotId,
        user_id: context.userId,
        mids,
        rid,
      });
      return okResult({
        streamId,
        requiresImmediateRenegotiation: res.requiresImmediateRenegotiation === true,
        ...(res.sessionDescription ? { sessionDescription: res.sessionDescription } : {}),
        tracks: mids.map(({ mid, kind }) => ({ mid, kind })),
        ...(rid !== null ? { rid } : {}),
        codec,
      });
    });
  }

  /** PUT .../renegotiate (viewer). */
  async rtcViewerRenegotiate(
    context: ConnectContext,
    sessionId: string,
    sessionDescription: SessionDescription,
  ): Promise<RtcResult<RenegotiateResponse>> {
    return this.rpc(context, async (rt) => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const res = await this.sfuQueue.run(sessionId, () =>
        rt.renegotiate(sessionId, sessionDescription),
      );
      return okResult(res.sessionDescription ? { sessionDescription: res.sessionDescription } : {});
    });
  }

  /** PUT .../layer: tracks/update on the same mid, no renegotiation. */
  async rtcLayer(
    context: ConnectContext,
    sessionId: string,
    streamId: string,
    rid: string,
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async (rt) => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const sub = this.store.subscription(sessionId, streamId);
      const sfu = this.store.streamSfu(streamId);
      const pulled = sub?.mids.find((m) => m.kind === 'video');
      const video = sfu?.tracks.find((t) => t.kind === 'video' && t.codec === pulled?.codec);
      const mid = pulled?.mid;
      if (!sub || !sfu || !video || !mid) {
        return fail(404, { code: ErrorCode.StreamNotFound, streamId });
      }
      if (video.codec === VideoCodec.Av1) {
        // The AV1 track is the top layer alone: staying there changes nothing;
        // another layer is a new pull on the H.264 track (POST .../subscribe with that rid).
        if (rid === sub.rid) return okResult(null, 204);
        return fail(409, { code: ErrorCode.InvalidMessage, path: '/rid' });
      }
      if (!(video.rids ?? []).includes(rid)) {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/rid' });
      }
      await this.sfuQueue.run(sessionId, () =>
        rt.updateTracks(sessionId, [{ ...remoteTrack(sfu.sfu_session_id, video, rid), mid }]),
      );
      this.accrueNow();
      this.store.setSubscriptionRid(sessionId, streamId, rid);
      return okResult(null, 204);
    });
  }

  /** POST .../unsubscribe: closes the stream's pulled tracks; the slot stays. */
  async rtcUnsubscribe(
    context: ConnectContext,
    sessionId: string,
    streamId: string,
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const sub = this.store.subscription(sessionId, streamId);
      if (sub) {
        this.store.deleteSubscription(sessionId, streamId);
        this.closeLater(
          sessionId,
          sub.mids.map((m) => m.mid),
        );
      }
      return okResult(null, 204);
    });
  }

  /** POST /api/rtc/leave (sendBeacon): closes everything pulled on the session and forgets it. */
  async rtcLeave(userId: string, sessionId: string): Promise<void> {
    this.begin();
    const session = this.store.viewerSession(sessionId);
    if (session && session.user_id === userId) this.forgetViewerSession(sessionId);
    await this.finish();
  }

  // --- RPC for the Worker: voice on the viewer session (docs/PROTOCOL.md 7.5, 11.2) ---

  /**
   * POST .../voice/publish: the caller's microphone as a local track on their viewer session
   * (tracks/new with their offer). Audio only; a previous microphone is closed first.
   */
  async rtcVoicePublish(
    context: ConnectContext,
    req: VoicePublishRequest,
  ): Promise<RtcResult<VoicePublishResponse>> {
    return this.rpc(context, async (rt) => {
      const { sessionId, sessionDescription, mid } = req;
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const refused = this.speakRefusal(context);
      if (refused) return refused;
      if (sessionDescription.type !== 'offer') {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/sessionDescription/type' });
      }
      // Web clients publish their microphone here, never video.
      if (mediaKindOfMid(sessionDescription.sdp, mid) !== 'audio') {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/mid' });
      }
      const old = this.store.voiceTrackOf(context.userId);
      if (old) {
        this.closeMicrophone(old);
        await this.drainCloses();
      }
      const trackId = newId('vt');
      const trackName = trackId;
      const res = await this.sfuQueue.run(sessionId, () =>
        rt.newTracks(sessionId, [{ location: 'local', mid, trackName }], sessionDescription),
      );
      if (res.sessionDescription?.type !== 'answer') throw new SfuError('body', 200, null);
      const publishedMid = res.tracks?.find((t) => t.trackName === trackName)?.mid ?? mid;
      // The caller may have left voice or been server-muted while the SFU answered.
      const after = this.speakRefusal(context);
      if (after) {
        this.closeLater(sessionId, [publishedMid]);
        return after;
      }
      // Another publish of the same user may have finished meanwhile: the newest one wins.
      const raced = this.store.voiceTrackOf(context.userId);
      if (raced) this.closeMicrophone(raced);
      this.store.insertVoiceTrack({
        track_id: trackId,
        user_id: context.userId,
        session_id: sessionId,
        track_name: trackName,
        mid: publishedMid,
      });
      this.sendVoiceTracks();
      return okResult(
        { trackId, mid: publishedMid, sessionDescription: res.sessionDescription },
        201,
      );
    });
  }

  /** POST .../voice/unpublish: closes the caller's microphone on this session. Idempotent. */
  async rtcVoiceUnpublish(context: ConnectContext, sessionId: string): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const track = this.store.voiceTrackOf(context.userId);
      if (track?.session_id === sessionId) {
        this.closeMicrophone(track);
        this.sendVoiceTracks();
      }
      return okResult(null, 204);
    });
  }

  /**
   * POST .../voice/subscribe: pulls 1 to 4 microphones onto the caller's viewer session in one
   * tracks/new. A track already pulled on the session is closed first (never pulled twice).
   */
  async rtcVoiceSubscribe(
    context: ConnectContext,
    req: VoiceSubscribeRequest,
  ): Promise<RtcResult<VoiceSubscribeResponse>> {
    return this.rpc(context, async (rt) => {
      const { sessionId, trackIds } = req;
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      if (!this.store.voiceParticipant(context.userId)) {
        return fail(409, { code: ErrorCode.VoiceNotJoined });
      }
      const tracks: VoiceTrackRow[] = [];
      for (const trackId of trackIds) {
        const t = this.store.voiceTrack(trackId);
        if (!t || t.user_id === context.userId) {
          return fail(404, { code: ErrorCode.VoiceTrackNotFound, trackId });
        }
        tracks.push(t);
      }
      for (const t of tracks) {
        const old = this.store.voicePull(sessionId, t.track_id);
        if (old) {
          this.store.deleteVoicePull(sessionId, t.track_id);
          this.closeLater(sessionId, [old.mid]);
        }
      }
      await this.drainCloses();
      const remote: SfuTrack[] = tracks.map((t) => ({
        location: 'remote',
        sessionId: t.session_id,
        trackName: t.track_name,
      }));
      const res = await this.sfuQueue.run(sessionId, () => rt.newTracks(sessionId, remote));
      const pulled = tracks.flatMap((t) => {
        const mid = res.tracks?.find((r) => r.trackName === t.track_name)?.mid;
        return mid ? [{ track: t, mid }] : [];
      });
      // Undo what went away while the SFU answered: the caller left voice, or a microphone did.
      const stillJoined = this.store.voiceParticipant(context.userId) !== null;
      const kept = pulled.filter(
        ({ track }) => stillJoined && this.store.voiceTrack(track.track_id) !== null,
      );
      for (const { mid } of pulled.filter((p) => !kept.includes(p))) {
        this.closeLater(sessionId, [mid]);
      }
      if (!stillJoined) return fail(409, { code: ErrorCode.VoiceNotJoined });
      this.accrueNow();
      for (const { track, mid } of kept) {
        this.store.upsertVoicePull({
          session_id: sessionId,
          track_id: track.track_id,
          user_id: context.userId,
          mid,
        });
      }
      return okResult({
        requiresImmediateRenegotiation: res.requiresImmediateRenegotiation === true,
        ...(res.sessionDescription ? { sessionDescription: res.sessionDescription } : {}),
        tracks: kept.map(({ track, mid }) => ({
          trackId: track.track_id,
          userId: track.user_id,
          mid,
        })),
      });
    });
  }

  /** POST .../voice/unsubscribe: closes voice pulls on the session (all when trackIds is absent). */
  async rtcVoiceUnsubscribe(
    context: ConnectContext,
    sessionId: string,
    trackIds?: string[],
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      this.accrueNow();
      const pulls = trackIds
        ? trackIds.flatMap((trackId) => {
            const pull = this.store.voicePull(sessionId, trackId);
            if (pull) this.store.deleteVoicePull(sessionId, trackId);
            return pull ? [pull] : [];
          })
        : this.store.takeVoicePulls({ sessionId });
      for (const pull of pulls) this.closeLater(sessionId, [pull.mid]);
      return okResult(null, 204);
    });
  }

  // --- RPC for the Worker: cameras on the viewer session (docs/PROTOCOL.md 7.7, 11.2) ---

  /**
   * POST .../camera/publish: the caller's camera as a simulcast local video on their viewer
   * session (tracks/new with their offer). Video only, at most two layers; a previous camera is
   * closed first. `quotaBlocked`: the Worker read that the quota blocks new streams (brake 4).
   */
  async rtcCameraPublish(
    context: ConnectContext,
    req: CameraPublishRequest,
    quotaBlocked: boolean,
  ): Promise<RtcResult<CameraPublishResponse>> {
    return this.rpc(context, async (rt) => {
      const { sessionId, sessionDescription, mid } = req;
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const refused = this.cameraRefusal(context);
      if (refused) return refused;
      if (quotaBlocked) return fail(403, { code: ErrorCode.QuotaExhausted });
      const limit = context.settings.maxCameras ?? DEFAULT_MAX_CAMERAS;
      const others =
        this.store.cameraTracks().filter((t) => t.user_id !== context.userId).length +
        [...this.cameraPublishing].filter((u) => u !== context.userId).length;
      if (others >= limit) return fail(409, { code: ErrorCode.CameraLimitReached, limit });
      if (sessionDescription.type !== 'offer') {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/sessionDescription/type' });
      }
      // The camera only: the microphone goes through voice/publish,
      // and two layers at most (360p and 180p), so a camera never costs more than planned.
      const rids = sendRidsOfMid(sessionDescription.sdp, mid);
      if (mediaKindOfMid(sessionDescription.sdp, mid) !== 'video' || !rids || rids.length > 2) {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/mid' });
      }
      const old = this.store.cameraTrackOf(context.userId);
      if (old) {
        this.closeCamera(old);
        await this.drainCloses();
      }
      const trackId = newId('ct');
      const trackName = trackId;
      this.cameraPublishing.add(context.userId);
      let res;
      try {
        res = await this.sfuQueue.run(sessionId, () =>
          rt.newTracks(sessionId, [{ location: 'local', mid, trackName }], sessionDescription),
        );
      } finally {
        this.cameraPublishing.delete(context.userId);
      }
      if (res.sessionDescription?.type !== 'answer') throw new SfuError('body', 200, null);
      const publishedMid = res.tracks?.find((t) => t.trackName === trackName)?.mid ?? mid;
      // The caller may have left voice or lost the camera while the SFU answered.
      const after = this.cameraRefusal(context);
      if (after) {
        this.closeLater(sessionId, [publishedMid]);
        return after;
      }
      // Another publish of the same user may have finished meanwhile: the newest one wins.
      const raced = this.store.cameraTrackOf(context.userId);
      if (raced) this.closeCamera(raced);
      this.store.insertCameraTrack({
        track_id: trackId,
        user_id: context.userId,
        session_id: sessionId,
        track_name: trackName,
        mid: publishedMid,
        rids,
        published_at: Date.now(),
      });
      const p = this.store.voiceParticipant(context.userId);
      if (p) this.broadcastWeb('voice.updated', { participant: this.participantOf(p) });
      this.sendVoiceTracks(context.userId);
      return okResult(
        { trackId, mid: publishedMid, rids, sessionDescription: res.sessionDescription },
        201,
      );
    });
  }

  /** POST .../camera/unpublish: turns the caller's camera on this session off. Idempotent. */
  async rtcCameraUnpublish(context: ConnectContext, sessionId: string): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      if (this.store.cameraTrackOf(context.userId)?.session_id === sessionId) {
        this.turnCameraOff(context.userId, null);
      }
      return okResult(null, 204);
    });
  }

  /**
   * POST .../camera/subscribe: pulls 1 to 4 cameras onto the caller's viewer session in one
   * tracks/new, on `rid` (default the lowest layer: the strip). A camera already pulled on the
   * session is closed first (never pulled twice).
   */
  async rtcCameraSubscribe(
    context: ConnectContext,
    req: CameraSubscribeRequest,
  ): Promise<RtcResult<CameraSubscribeResponse>> {
    return this.rpc(context, async (rt) => {
      const { sessionId, trackIds } = req;
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      if (!this.store.voiceParticipant(context.userId)) {
        return fail(409, { code: ErrorCode.VoiceNotJoined });
      }
      const cameras: { track: CameraTrackRow; rid: string | null }[] = [];
      for (const trackId of trackIds) {
        const t = this.store.cameraTrack(trackId);
        if (!t || t.user_id === context.userId) {
          return fail(404, { code: ErrorCode.VoiceTrackNotFound, trackId });
        }
        if (req.rid !== undefined && t.rids.length > 0 && !t.rids.includes(req.rid)) {
          return fail(400, { code: ErrorCode.InvalidMessage, path: '/rid' });
        }
        cameras.push({
          track: t,
          rid: t.rids.length > 0 ? (req.rid ?? t.rids.at(-1) ?? null) : null,
        });
      }
      for (const { track } of cameras) {
        const old = this.store.cameraPull(sessionId, track.track_id);
        if (old) {
          this.store.deleteCameraPull(sessionId, track.track_id);
          this.closeLater(sessionId, [old.mid]);
        }
      }
      await this.drainCloses();
      const res = await this.sfuQueue.run(sessionId, () =>
        rt.newTracks(
          sessionId,
          cameras.map(({ track, rid }) => remoteCamera(track, rid)),
        ),
      );
      const pulled = cameras.flatMap((c) => {
        const mid = res.tracks?.find((r) => r.trackName === c.track.track_name)?.mid;
        return mid ? [{ ...c, mid }] : [];
      });
      // Undo what went away while the SFU answered: the caller left voice, or a camera did.
      const stillJoined = this.store.voiceParticipant(context.userId) !== null;
      const kept = pulled.filter(
        ({ track }) => stillJoined && this.store.cameraTrack(track.track_id) !== null,
      );
      for (const { mid } of pulled.filter((p) => !kept.includes(p))) {
        this.closeLater(sessionId, [mid]);
      }
      if (!stillJoined) return fail(409, { code: ErrorCode.VoiceNotJoined });
      this.accrueNow();
      for (const { track, mid, rid } of kept) {
        // Every pull starts on the top layer: a join at the high layer's rate.
        addJoin(this.store, CAMERA_LAYERS.h.kbps, Date.now());
        this.store.upsertCameraPull({
          session_id: sessionId,
          track_id: track.track_id,
          user_id: context.userId,
          mid,
          rid,
        });
      }
      return okResult({
        requiresImmediateRenegotiation: res.requiresImmediateRenegotiation === true,
        ...(res.sessionDescription ? { sessionDescription: res.sessionDescription } : {}),
        tracks: kept.map(({ track, mid, rid }) => ({
          trackId: track.track_id,
          userId: track.user_id,
          mid,
          ...(rid !== null ? { rid } : {}),
        })),
      });
    });
  }

  /** PUT .../camera/layer: tracks/update on the same mid, no renegotiation (strip ↔ enlarged). */
  async rtcCameraLayer(
    context: ConnectContext,
    sessionId: string,
    trackId: string,
    rid: string,
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async (rt) => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      const pull = this.store.cameraPull(sessionId, trackId);
      const track = this.store.cameraTrack(trackId);
      if (!pull || !track) return fail(404, { code: ErrorCode.VoiceTrackNotFound, trackId });
      if (!track.rids.includes(rid)) {
        return fail(400, { code: ErrorCode.InvalidMessage, path: '/rid' });
      }
      await this.sfuQueue.run(sessionId, () =>
        rt.updateTracks(sessionId, [{ ...remoteCamera(track, rid), mid: pull.mid }]),
      );
      this.accrueNow();
      if (this.store.cameraPull(sessionId, trackId)) {
        this.store.setCameraPullRid(sessionId, trackId, rid);
      }
      return okResult(null, 204);
    });
  }

  /** POST .../camera/unsubscribe: closes camera pulls on the session (all without trackIds). */
  async rtcCameraUnsubscribe(
    context: ConnectContext,
    sessionId: string,
    trackIds?: string[],
  ): Promise<RtcResult<null>> {
    return this.rpc(context, async () => {
      const owned = this.ownViewerSession(context.userId, sessionId);
      if (owned) return owned;
      this.accrueNow();
      const pulls = trackIds
        ? trackIds.flatMap((trackId) => {
            const pull = this.store.cameraPull(sessionId, trackId);
            if (pull) this.store.deleteCameraPull(sessionId, trackId);
            return pull ? [pull] : [];
          })
        : this.store.takeCameraPulls({ sessionId });
      for (const pull of pulls) this.closeLater(sessionId, [pull.mid]);
      return okResult(null, 204);
    });
  }

  /** Why the caller may not turn a camera on now, or null. */
  private cameraRefusal(context: ConnectContext): Failure | null {
    if (!this.cameraCapability()) {
      return fail(403, { code: ErrorCode.CapabilityDisabled, capability: Capability.Camera });
    }
    if (!this.store.voiceParticipant(context.userId)) {
      return fail(409, { code: ErrorCode.VoiceNotJoined });
    }
    if (!this.cameraAllowed(context.role)) return fail(403, { code: ErrorCode.CameraNotAllowed });
    return null;
  }

  /** Why the caller may not publish a microphone now, or null. */
  private speakRefusal(context: ConnectContext): Failure | null {
    const p = this.store.voiceParticipant(context.userId);
    if (!p) return fail(409, { code: ErrorCode.VoiceNotJoined });
    const settings = this.store.settings();
    const speak = canSpeakAs(
      context.role,
      settings?.capabilities ?? STREAM_ONLY,
      settings?.guestsCanSpeak ?? true,
    );
    if (!speak.allowed || p.server_muted) {
      return fail(403, { code: ErrorCode.VoiceSpeakNotAllowed });
    }
    return null;
  }

  /** Shared plumbing of the SFU RPCs: snapshot, meter, SFU errors, finish. */
  private async rpc<T>(
    context: ConnectContext,
    fn: (rt: Realtime, now: number) => Promise<RtcResult<T>>,
  ): Promise<RtcResult<T>> {
    const config = realtimeConfig(this.env);
    if (!config) return fail(503, { code: ErrorCode.RtcNotConfigured });
    this.begin();
    this.refresh(context);
    try {
      return await fn(new Realtime(config), Date.now());
    } catch (err) {
      if (err instanceof SfuError) return fail(502, { code: ErrorCode.SfuError });
      throw err;
    } finally {
      await this.finish();
    }
  }

  private ownViewerSession(userId: string, sessionId: string): Failure | null {
    const session = this.store.viewerSession(sessionId);
    return session && session.user_id === userId
      ? null
      : fail(404, { code: ErrorCode.SfuSessionNotFound, sessionId });
  }

  private forgetViewerSession(sessionId: string): void {
    for (const pull of this.store.takeVoicePulls({ sessionId })) {
      this.closeLater(sessionId, [pull.mid]);
    }
    for (const t of this.store.voiceTracks()) {
      if (t.session_id === sessionId) this.closeMicrophone(t);
    }
    for (const pull of this.store.takeCameraPulls({ sessionId })) {
      this.closeLater(sessionId, [pull.mid]);
    }
    for (const t of this.store.cameraTracks()) {
      if (t.session_id === sessionId) this.turnCameraOff(t.user_id, null);
    }
    for (const sub of this.store.subscriptionsOfSession(sessionId)) {
      this.store.deleteSubscription(sessionId, sub.stream_id);
      this.closeLater(
        sessionId,
        sub.mids.map((m) => m.mid),
      );
    }
    this.store.deleteViewerSession(sessionId);
  }

  /** Remembers a Realtime session in D1 for reconciliation per space. */
  private async recordSession(
    sessionId: string,
    context: ConnectContext,
    kind: 'publish' | 'browser_publish' | 'view',
    deviceId: string | null,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO realtime_sessions
           (session_id, space_id, room_id, user_id, device_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          sessionId,
          context.room.spaceId,
          context.room.roomId,
          context.userId,
          deviceId,
          kind,
          Date.now(),
        )
        .run();
    } catch (err) {
      console.error('realtime_sessions insert failed', err);
    }
  }

  // --- Event bracket: meter, SFU cleanup, alarm ---

  private refresh(context: ConnectContext): void {
    this.store.setRoom(context.room);
    this.store.setSettings(context.settings);
  }

  private begin(): void {
    const now = Date.now();
    const key = accrue(this.store, this.rates(), now);
    this.savedRateKey ??= key;
    // Leases that ran out since the last event (the alarm only sweeps every room tick).
    this.expire(now, false);
  }

  private accrueNow(): void {
    accrue(this.store, this.rates(), Date.now());
  }

  private rates(): StreamRates {
    const topKbps = new Map<string, number>();
    const rids = new Map<string, readonly string[]>();
    const av1Modes = new Map<string, Av1Mode>();
    const settings = this.store.settings();
    for (const s of this.store.streams()) {
      const pub = this.store.publicationOfStream(s.streamId);
      if (!pub) continue;
      // A capped stream publishes at most the cap (brake 3).
      const cap = this.qualityCap();
      topKbps.set(
        s.streamId,
        cap ? Math.min(pub.max_bitrate_kbps, cap.maxBitrateKbps) : pub.max_bitrate_kbps,
      );
      rids.set(s.streamId, pub.tracks.find((t) => t.kind === 'video')?.rids ?? []);
      av1Modes.set(s.streamId, av1ModeFor(settings, s.preset));
    }
    return { topKbps, rids, av1Modes };
  }

  /** `handledAt`: the event is the alarm, started at that time (see scheduleAlarm). */
  private async finish(handledAt: number | null = null): Promise<void> {
    for (const sub of this.store.takeOrphanSubscriptions()) {
      this.closeLater(
        sub.session_id,
        sub.mids.map((m) => m.mid),
      );
    }
    await this.drainCloses();
    await this.drainThumbnailDeletes();
    const due = this.store.getNumber(METER_DUE_KEY);
    if (this.flushPending || (due !== null && due <= Date.now())) {
      this.flushPending = false;
      await this.flushMeter();
    }
    // Streams with an SFU publication are metered (test streams made by upsertStream are not).
    const rates = this.rates();
    const metered =
      rates.topKbps.size > 0 ||
      this.store.voicePullCount() > 0 ||
      this.store.cameraPullLayers().length > 0;
    const now = Date.now();
    // Flushed every room tick while metered (the estimate in D1 and the quota brakes are at most
    // ROOM_TICK_MS behind). Moved in place once per flush, not deleted and re-created.
    if (metered ? due === null || due <= now : due !== null && due <= now) {
      this.store.setNumber(METER_DUE_KEY, metered ? nextTick(now) : null);
    }
    // The meter's totals are written only when what accrues per second changed (room/meter.ts).
    const key = rateKey(this.store, rates);
    if (key !== this.savedRateKey) {
      this.store.saveMeter();
      this.savedRateKey = key;
    }
    await this.pushPresence();
    await this.scheduleAlarm(handledAt);
  }

  // --- Presence in the space sidebar (PROTOCOL.md 7.8) ---

  /**
   * Pushes the room's summary to its SpaceDO when it changed since the last push: at once when
   * that push is PRESENCE_DEBOUNCE_MS old, otherwise from the alarm at the end of that window. A
   * non-empty summary is pushed again within PRESENCE_REFRESH_MS, on a room tick.
   */
  private async pushPresence(): Promise<void> {
    const room = this.store.room();
    if (!room) return;
    const now = Date.now();
    const update: RoomPresenceUpdate = {
      roomId: room.roomId,
      visibility: room.visibility,
      ...this.presenceSummary(),
    };
    const empty = update.voice.length === 0 && update.live.length === 0;
    const json = JSON.stringify(update);
    const sent = this.store.getText(PRESENCE_SENT_KEY);
    const lastAt = this.store.getNumber(PRESENCE_AT_KEY) ?? 0;
    // A room that never had anyone has nothing to retract.
    const changed = sent === null ? !empty : json !== sent;
    const refreshAt = (at: number) => nextTick(at + PRESENCE_REFRESH_MS - ROOM_TICK_MS);
    const refresh = !empty && now >= refreshAt(lastAt);
    if (!changed && !refresh) {
      this.presenceDue = empty ? null : refreshAt(lastAt);
      return;
    }
    if (now - lastAt < PRESENCE_DEBOUNCE_MS) {
      this.presenceDue = lastAt + PRESENCE_DEBOUNCE_MS;
      return;
    }
    try {
      await this.env.SPACE.get(this.env.SPACE.idFromName(room.spaceId)).roomPresence(update);
    } catch (err) {
      console.error('presence push failed', err);
      this.presenceDue = now + PRESENCE_RETRY_MS;
      return;
    }
    this.store.setText(PRESENCE_SENT_KEY, json);
    this.store.setNumber(PRESENCE_AT_KEY, now);
    this.presenceDue = empty ? null : refreshAt(now);
  }

  /** Who is in voice and who streams, with the names their sockets carry. */
  private presenceSummary(): Pick<RoomPresenceUpdate, 'voice' | 'live'> {
    const voice: VoicePresence[] = [];
    for (const p of this.store.voiceParticipants()) {
      // A participant whose tab is gone (a restart) is pruned on the next voice event.
      const a = this.voiceAttachment(p);
      if (!a) continue;
      voice.push({
        userId: p.user_id,
        displayName: a.displayName,
        ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        muted: p.muted || p.deafened || p.server_muted,
        deafened: p.deafened,
        ...(this.store.cameraTrackOf(p.user_id) ? { camera: true } : {}),
      });
    }
    const live: LivePresence[] = this.store
      .streams()
      .sort((x, y) => x.startedAt - y.startedAt)
      .map((st) => {
        const ws = this.userSockets(st.userId)[0];
        const a = ws ? attachmentOf(ws) : null;
        return {
          userId: st.userId,
          streamId: st.streamId,
          ...(a ? { displayName: a.displayName } : {}),
          ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
          ...(st.paused ? { paused: true } : {}),
        };
      });
    return { voice, live };
  }

  private closeLater(sessionId: string, mids: string[]): void {
    if (mids.length > 0) this.pendingCloses.push({ sessionId, mids });
  }

  /** Closes the queued SFU tracks (force), serialized per session; failures are only logged. */
  private async drainCloses(): Promise<void> {
    const jobs = this.pendingCloses;
    this.pendingCloses = [];
    if (jobs.length === 0) return;
    const config = realtimeConfig(this.env);
    if (!config) return;
    const rt = new Realtime(config);
    await Promise.all(
      jobs.flatMap(({ sessionId, mids }) =>
        chunks(mids).map((part) =>
          this.sfuQueue
            .run(sessionId, () => rt.closeTracks(sessionId, part))
            .catch((err: unknown) => {
              if (!(err instanceof SfuError)) console.error('tracks/close failed', err);
            }),
        ),
      ),
    );
  }

  /** Deletes the queued R2 thumbnails; a failure is only logged (the scheduled sweep retries). */
  private async drainThumbnailDeletes(): Promise<void> {
    const keys = this.pendingThumbnailDeletes;
    this.pendingThumbnailDeletes = [];
    if (keys.length === 0) return;
    try {
      await this.env.THUMBNAILS.delete(keys);
    } catch (err) {
      console.error('thumbnail delete failed', err);
    }
  }

  /** Brake 3 changed: every stream's StreamInfo gains or loses its qualityCap. */
  private setEconomy(on: boolean): void {
    if (this.economy() === on) return;
    this.store.setNumber(ECONOMY_KEY, on ? 1 : null);
    for (const s of this.store.streams()) {
      this.broadcast('stream.updated', { stream: this.streamInfo(s) });
    }
  }

  private economy(): boolean {
    return this.store.getNumber(ECONOMY_KEY) === 1;
  }

  private qualityCap(): QualityCap | null {
    return this.economy() ? ECONOMY_CAP : null;
  }

  /**
   * Writes the meter's totals to usage_daily, then applies the quota brake to
   * running streams (brake 4): once the instance's quota blocks new streams, they end after the
   * grace period.
   */
  private async flushMeter(): Promise<void> {
    const room = this.store.room();
    if (!room) return;
    this.accrueNow();
    const now = Date.now();
    const m = this.store.meter(now);
    try {
      const settings = await platformSettings(this.env.DB);
      const f = flushAmounts(m, overheads(settings.overheads));
      if (f.gb > 0 || f.viewerMinutes > 0 || f.streamMinutes > 0) {
        await recordEstimate(
          this.env.DB,
          room.spaceId,
          new Date(now).toISOString().slice(0, 10),
          f.gb,
          f.viewerMinutes,
          f.streamMinutes,
        );
      }
      // Subtract what was written: other events may have accrued meanwhile.
      const cur = this.store.meter(Date.now());
      this.store.setMeter({
        ...cur,
        viewer_mbit_s: cur.viewer_mbit_s - m.viewer_mbit_s,
        join_mbps: cur.join_mbps - m.join_mbps,
        viewer_s: cur.viewer_s - f.viewerMinutes * 60,
        stream_s: cur.stream_s - f.streamMinutes * 60,
      });
      this.store.saveMeter();
      if (this.store.streams().length > 0 || this.store.cameraTracks().length > 0) {
        await this.quotaBrake(settings);
      }
    } catch (err) {
      // Kept for the next flush.
      console.error('usage flush failed', err);
    }
  }

  private async quotaBrake(settings: Awaited<ReturnType<typeof platformSettings>>) {
    const now = Date.now();
    const quota = await instanceQuota(this.env.DB, new Date(now), settings);
    this.setEconomy(quota.state.economyMode);
    if (!quota.state.blockNewStreams) {
      this.store.setNumber(QUOTA_BLOCKED_KEY, null);
      return;
    }
    const blockedAt = this.store.getNumber(QUOTA_BLOCKED_KEY) ?? now;
    this.store.setNumber(QUOTA_BLOCKED_KEY, blockedAt);
    if (now >= blockedAt + quota.brakes.graceMinutes * 60_000) {
      this.endStreamsOf(() => true, StreamEndReason.QuotaExhausted, true);
      // Cameras go too; the voice keeps going (question 2).
      for (const t of this.store.cameraTracks()) {
        this.turnCameraOff(t.user_id, CameraStopReason.QuotaExhausted);
      }
      for (const sub of this.store.takeOrphanSubscriptions()) {
        this.closeLater(
          sub.session_id,
          sub.mids.map((m) => m.mid),
        );
      }
      await this.drainCloses();
    }
  }

  // --- Handshake and presence ---

  private onHello(
    ws: WebSocket,
    me: Attachment,
    hello: PayloadOf<'hello'>,
    id: MessageId | undefined,
  ): void {
    if (hello.protocol.major !== PROTOCOL_VERSION.major) {
      this.sendError(
        ws,
        {
          code: ErrorCode.ProtocolUnsupported,
          minProtocol: MIN_PROTOCOL,
          maxProtocol: PROTOCOL_VERSION,
        },
        id,
      );
      this.disconnect(ws, CloseCode.ProtocolUnsupported);
      return;
    }
    // A device token connects only as that device's helper, and only it may (PROTOCOL.md 4).
    if (
      (me.deviceId !== undefined || hello.client === 'helper') &&
      (hello.client !== 'helper' || hello.deviceId !== me.deviceId)
    ) {
      this.sendError(ws, { code: ErrorCode.Unauthenticated }, id);
      this.disconnect(ws, CloseCode.Unauthenticated);
      return;
    }
    const presentBefore = this.presentUsers();
    const wasPresent = presentBefore.has(me.userId);
    const key = hello.client === 'helper' ? hello.deviceId : hello.tabId;
    const updated: Attachment = {
      ...me,
      hello: {
        client: hello.client,
        ...(hello.deviceId ? { deviceId: hello.deviceId } : {}),
        ...(hello.tabId ? { tabId: hello.tabId } : {}),
      },
    };
    ws.serializeAttachment(updated);

    // A newer connection of the same client replaces the older one (close 4002).
    if (key) {
      for (const other of this.userSockets(me.userId)) {
        const o = attachmentOf(other);
        if (other === ws || o.hello?.client !== hello.client) continue;
        if ((hello.client === 'helper' ? o.hello.deviceId : o.hello.tabId) === key) {
          this.disconnect(other, CloseCode.Replaced);
        }
      }
    }
    // A helper back within the grace period keeps its streams; so does a browser tab's.
    if (hello.client === 'helper' && me.deviceId) {
      const deviceId = me.deviceId;
      this.store.setGrace(
        this.streamIdsOf((s) => s.deviceId === deviceId),
        null,
      );
    } else if (hello.client === 'web' && hello.tabId) {
      this.store.setGrace(this.store.browserStreamsOfTab(me.userId, hello.tabId), null);
    }

    const room = this.store.room();
    const settings = this.store.settings();
    if (!room || !settings) throw new Error('room snapshot missing after connect');
    this.pruneVoice();
    const voice =
      hello.client === 'web' && this.voiceCapability()
        ? { voice: this.store.voiceParticipants().map((p) => this.participantOf(p)) }
        : {};
    // Nobody was here: a room without history starts empty (a restart may have skipped the close).
    if (presentBefore.size === 0) this.chat.emptied();
    this.chat.connected(updated);
    const chat =
      hello.client === 'web' && this.textCapability() ? { chat: this.chat.summary(me.userId) } : {};
    send(
      ws,
      'welcome',
      {
        protocol: PROTOCOL_VERSION,
        minProtocol: MIN_PROTOCOL,
        serverTime: Date.now(),
        you: this.you(updated),
        room,
        settings,
        members: this.presentMembers(),
        streams: this.store.streams().map((s) => this.streamInfo(s)),
        ...voice,
        ...chat,
      },
      id,
    );
    if (!wasPresent) this.broadcast('member.joined', { member: member(updated) }, ws);
  }

  /**
   * Closes a socket from the server side and cleans up after it at once; also the handler for a
   * client-side close. Idempotent: the runtime may report a close after we started one.
   */
  private disconnect(ws: WebSocket, code: CloseCode | typeof BREAKER_CLOSE_CODE): void {
    const me = attachmentOf(ws);
    if (me.closing) return;
    ws.serializeAttachment({ ...me, closing: true } satisfies Attachment);
    try {
      ws.close(code, CLOSE_REASONS[code]);
    } catch {
      // Already closed.
    }
    if (!me.hello) return;
    if (this.store.voiceParticipant(me.userId)?.connection_id === me.connectionId) {
      this.leaveVoice(me.userId, VoiceLeftReason.Disconnected);
    }
    const before = new Map<string, Map<string, number>>();
    for (const streamId of this.queuedStreams(me.connectionId)) {
      before.set(streamId, this.store.positions(streamId));
    }
    for (const streamId of this.store.releaseConnection(me.connectionId)) {
      this.settle(streamId, before.get(streamId) ?? new Map());
    }
    // The last socket of a helper: its streams survive HELPER_GRACE_MS.
    const deviceId = me.deviceId;
    if (me.hello.client === 'helper' && deviceId && !this.helperSockets(deviceId).length) {
      this.store.setGrace(
        this.streamIdsOf((s) => s.deviceId === deviceId),
        Date.now() + HELPER_GRACE_MS,
      );
    }
    // The last socket of a tab streaming from the browser: the same grace (since 1.22).
    const tabId = me.hello.tabId;
    if (me.hello.client === 'web' && tabId && !this.tabSockets(me.userId, tabId).length) {
      this.store.setGrace(
        this.store.browserStreamsOfTab(me.userId, tabId),
        Date.now() + HELPER_GRACE_MS,
      );
    }
    const present = this.presentUsers();
    if (!present.has(me.userId)) {
      this.broadcast('member.left', { userId: me.userId });
    }
    if (present.size === 0) this.chat.emptied();
  }

  private close(reason: RoomCloseReason): number {
    const sockets = this.ctx.getWebSockets();
    // Streams end first, so everyone hears stream.ended and the helpers stream.stop.
    this.endStreamsOf(() => true, StreamEndReason.RoomClosed, true);
    for (const pub of this.store.allPublications()) {
      this.closeLater(
        pub.sfu_session_id,
        pub.tracks.map((t) => t.mid),
      );
    }
    for (const sub of this.store.allSubscriptions()) {
      this.closeLater(
        sub.session_id,
        sub.mids.map((m) => m.mid),
      );
    }
    for (const t of this.store.voiceTracks()) this.closeLater(t.session_id, [t.mid]);
    for (const pull of this.store.takeVoicePulls({})) this.closeLater(pull.session_id, [pull.mid]);
    for (const t of this.store.cameraTracks()) this.closeLater(t.session_id, [t.mid]);
    for (const pull of this.store.takeCameraPulls({})) this.closeLater(pull.session_id, [pull.mid]);
    // Mark everyone first so nobody gets member.left or viewers noise while the room closes.
    for (const ws of sockets) {
      const a = attachmentOf(ws);
      if (a.closing) continue;
      ws.serializeAttachment({ ...a, closing: true } satisfies Attachment);
      send(ws, 'room.closed', { reason });
      try {
        ws.close(CloseCode.RoomClosed, CLOSE_REASONS[CloseCode.RoomClosed]);
      } catch {
        // Already closed.
      }
    }
    this.store.clearViewers();
    this.store.clearRtc();
    // The room is gone for good (not suspended or out of quota): its chat goes with it.
    if (ROOM_ENDS.has(reason)) this.chat.ended();
    return sockets.length;
  }

  // --- Streams (PROTOCOL.md 7.2) ---

  private onStreamAnnounce(
    ws: WebSocket,
    me: Attachment,
    a: PayloadOf<'stream.announce'>,
    id?: MessageId,
  ): void {
    const roomId = this.store.room()?.roomId;
    const settings = this.store.settings();
    const pub = this.store.publication(a.sfuSessionId);
    // A web tab announces only its own browser publication (since 1.22); anything else from the
    // web is forbidden, as before, without saying whether the session exists.
    const browser =
      me.hello?.client === 'web' &&
      !!me.hello.tabId &&
      !!pub &&
      pub.user_id === me.userId &&
      pub.tab_id === me.hello.tabId;
    if ((me.hello?.client !== 'helper' || !me.deviceId) && !browser) {
      return this.sendError(ws, { code: ErrorCode.Forbidden, ...(roomId ? { roomId } : {}) }, id);
    }
    if (!settings) {
      return this.sendError(ws, { code: ErrorCode.Forbidden, ...(roomId ? { roomId } : {}) }, id);
    }
    if (
      !pub ||
      pub.stream_id !== null ||
      pub.user_id !== me.userId ||
      (browser
        ? pub.tab_id !== me.hello?.tabId
        : pub.device_id !== me.deviceId || pub.tab_id !== null)
    ) {
      return this.sendError(
        ws,
        { code: ErrorCode.SfuSessionNotFound, sessionId: a.sfuSessionId.slice(0, 64) },
        id,
      );
    }
    const tracks: PublishedTrackRow[] = [];
    for (const [i, t] of a.tracks.entries()) {
      const p = pub.tracks.find((x) => x.name === t.name);
      const sameRids = !t.rids?.length || JSON.stringify(t.rids) === JSON.stringify(p?.rids ?? []);
      if (!p || p.kind !== t.kind || !sameRids || tracks.some((x) => x.name === t.name)) {
        return this.sendError(
          ws,
          { code: ErrorCode.InvalidMessage, path: `/payload/tracks/${i}` },
          id,
        );
      }
      tracks.push(p);
    }
    if (a.layers && !layersMatch(a.layers, tracks)) {
      return this.sendError(ws, { code: ErrorCode.InvalidMessage, path: '/payload/layers' }, id);
    }
    if (!me.permissions.canStream) {
      return this.sendError(
        ws,
        { code: ErrorCode.StreamPermissionRequired, ...(roomId ? { roomId } : {}) },
        id,
      );
    }
    if (!settings.allowedPresets.includes(a.preset) || (browser && !isBrowserPreset(a.preset))) {
      return this.sendError(ws, { code: ErrorCode.PresetNotAllowed, preset: a.preset }, id);
    }
    if (this.store.streams().length >= settings.maxStreams) {
      return this.sendError(
        ws,
        { code: ErrorCode.StreamLimitReached, limit: settings.maxStreams },
        id,
      );
    }
    const streamId = newId('st');
    const roomLimit = settings.maxViewersPerStream;
    const stream: RoomStream = {
      streamId,
      userId: me.userId,
      deviceId: pub.device_id,
      source: a.source,
      preset: a.preset,
      hasAudio: a.hasAudio,
      paused: false,
      startedAt: Date.now(),
      viewerLimit: Math.min(a.viewerLimit ?? roomLimit, roomLimit),
      ...(a.layers ? { layers: a.layers } : {}),
      // A new stream always starts with pings off (PROTOCOL.md 7.9); a browser draws none.
      ...(a.pingOverlay && !browser ? { pingOverlay: true } : {}),
      ...(browser ? { origin: 'browser' as const } : {}),
    };
    this.store.upsertStream(stream);
    this.store.insertStreamSfu({
      stream_id: streamId,
      sfu_session_id: pub.sfu_session_id,
      streamer_role: me.role,
      tracks,
      grace_until: null,
    });
    this.store.announcePublication(pub.sfu_session_id, streamId);
    this.ctx.waitUntil(this.recordStreamStart(stream));
    const info = this.streamInfo(stream);
    send(ws, 'stream.started', { stream: info }, id);
    this.broadcast('stream.started', { stream: info }, ws);
    this.broadcastViewers(streamId);
  }

  private onStreamUpdate(
    ws: WebSocket,
    me: Attachment,
    u: PayloadOf<'stream.update'>,
    id?: MessageId,
  ): void {
    const stream = this.ownPublisherStream(ws, me, u.streamId, id);
    if (!stream) return;
    const allowed = this.store.settings()?.allowedPresets ?? [];
    const browserCap = stream.origin === 'browser' && u.preset !== undefined;
    if (
      u.preset !== undefined &&
      (!allowed.includes(u.preset) || (browserCap && !isBrowserPreset(u.preset)))
    ) {
      return this.sendError(ws, { code: ErrorCode.PresetNotAllowed, preset: u.preset }, id);
    }
    if (u.layers && !layersMatch(u.layers, this.store.streamSfu(u.streamId)?.tracks ?? [])) {
      return this.sendError(ws, { code: ErrorCode.InvalidMessage, path: '/payload/layers' }, id);
    }
    const paused = u.paused ?? stream.paused;
    // A new preset replaces the layers: with the ones sent, or none (a helper before 1.19).
    const { pauseReason: oldReason, layers: oldLayers, ...rest } = stream;
    const layers = u.layers ?? (u.preset !== undefined ? undefined : oldLayers);
    const pauseReason = paused ? (u.pauseReason ?? oldReason) : undefined;
    // Pausing drops the last thumbnail at once; the helper's placeholder follows.
    const { thumbnailAt, ...kept } = rest;
    const dropThumbnail = paused && !stream.paused && thumbnailAt !== undefined;
    if (dropThumbnail) this.pendingThumbnailDeletes.push(thumbnailKey(stream.streamId));
    const next: RoomStream = {
      ...kept,
      ...(thumbnailAt !== undefined && !dropThumbnail ? { thumbnailAt } : {}),
      paused,
      ...(pauseReason ? { pauseReason } : {}),
      ...(u.preset !== undefined ? { preset: u.preset } : {}),
      ...(layers ? { layers } : {}),
    };
    this.store.upsertStream(next);
    if (id) send(ws, 'ack', {}, id);
    this.broadcast('stream.updated', { stream: this.streamInfo(next) });
  }

  private onStreamEnd(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    if (!this.ownPublisherStream(ws, me, streamId, id)) return;
    this.endStream(streamId, StreamEndReason.EndedByStreamer);
    if (id) send(ws, 'ack', {}, id);
  }

  private onSetViewerLimit(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'stream.setViewerLimit'>,
    id?: MessageId,
  ): void {
    const stream = this.store.stream(p.streamId);
    if (!stream) {
      return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId: p.streamId }, id);
    }
    const allowed =
      me.hello?.client === 'helper'
        ? stream.deviceId === me.deviceId && stream.userId === me.userId
        : this.mayModerate(me, stream);
    if (!allowed) return this.forbidden(ws, id);
    const roomLimit = this.store.settings()?.maxViewersPerStream ?? stream.viewerLimit;
    if (p.limit > roomLimit) {
      return this.sendError(
        ws,
        { code: ErrorCode.ViewerLimitTooHigh, streamId: p.streamId, limit: roomLimit },
        id,
      );
    }
    const before = this.store.positions(p.streamId);
    const next = { ...stream, viewerLimit: p.limit };
    this.store.upsertStream(next);
    if (id) send(ws, 'ack', {}, id);
    this.broadcast('stream.updated', { stream: this.streamInfo(next) });
    this.settle(p.streamId, before);
  }

  private onStreamTerminate(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    const stream = this.store.stream(streamId);
    if (!stream) return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId }, id);
    if (me.hello?.client !== 'web' || !this.mayModerate(me, stream)) {
      return this.forbidden(ws, id);
    }
    const reason =
      stream.userId === me.userId
        ? StreamEndReason.EndedByStreamer
        : StreamEndReason.EndedByModerator;
    this.endStream(streamId, reason, true);
    if (id) send(ws, 'ack', {}, id);
  }

  // --- Visual pointer pings (PROTOCOL.md 7.9) ---

  /** The streamer allows or forbids pings on their own stream, from the web. */
  private onSetPings(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'stream.setPings'>,
    id?: MessageId,
  ): void {
    const stream = this.store.stream(p.streamId);
    if (!stream) {
      return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId: p.streamId }, id);
    }
    if (me.hello?.client !== 'web' || stream.userId !== me.userId) return this.forbidden(ws, id);
    // Enabling needs a helper that can draw the pings.
    if (p.enabled && !stream.pingOverlay) return this.forbidden(ws, id);
    const next: RoomStream = { ...stream, pings: p.enabled };
    this.store.upsertStream(next);
    if (id) send(ws, 'ack', {}, id);
    this.broadcast('stream.updated', { stream: this.streamInfo(next) });
  }

  /** A viewer's ping, forwarded only to the publishing helper. */
  private onPointerPing(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'pointer.ping'>,
    id?: MessageId,
  ): void {
    const stream = this.store.stream(p.streamId);
    if (!stream) {
      return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId: p.streamId }, id);
    }
    const now = Date.now();
    const holdsSlot = this.store
      .slotsOf(p.streamId)
      .some((s) => s.user_id === me.userId && s.expires_at > now);
    if (me.hello?.client !== 'web' || stream.userId === me.userId || !holdsSlot) {
      return this.forbidden(ws, id);
    }
    if (!stream.pings) {
      return this.sendError(ws, { code: ErrorCode.PingsDisabled, streamId: p.streamId }, id);
    }
    const retryAfterMs = this.pingBuckets.take(me.userId, now);
    if (retryAfterMs > 0) {
      return this.sendError(ws, { code: ErrorCode.RateLimited, retryAfterMs }, id);
    }
    // Paused (privacy curtain, hidden source): dropped without an error.
    if (stream.paused) return;
    this.sendToDevice(stream.deviceId, 'pointer.pinged', {
      streamId: p.streamId,
      userId: me.userId,
      name: me.displayName,
      x: p.x,
      y: p.y,
      style: p.style,
    });
  }

  /** The streamer, or a moderator under the same rule as removing someone. */
  private mayModerate(me: Attachment, stream: RoomStream): boolean {
    if (stream.userId === me.userId) return true;
    if (!me.permissions.canModerate) return false;
    if (me.role === 'owner') return true;
    const target = this.store.streamSfu(stream.streamId)?.streamer_role ?? 'member';
    return me.role === 'admin' && target !== 'owner' && target !== 'admin';
  }

  /**
   * The stream, when this connection publishes it: the helper of its device, or (since 1.22) the
   * web tab of its browser publication. Else replies the error.
   */
  private ownPublisherStream(
    ws: WebSocket,
    me: Attachment,
    streamId: string,
    id?: MessageId,
  ): RoomStream | null {
    const stream = this.store.stream(streamId);
    if (!stream) {
      this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId }, id);
      return null;
    }
    const tabId = me.hello?.client === 'web' ? me.hello.tabId : undefined;
    const owns =
      stream.userId === me.userId &&
      (me.hello?.client === 'helper'
        ? stream.origin !== 'browser' && stream.deviceId === me.deviceId
        : stream.origin === 'browser' &&
          !!tabId &&
          this.store.publicationOfStream(streamId)?.tab_id === tabId);
    if (!owns) {
      this.forbidden(ws, id);
      return null;
    }
    return stream;
  }

  /**
   * Ends a stream: stream.stop to its helper when asked, stream.ended to everyone, its slots and
   * queue dropped (stream.ended implies them), its publisher tracks queued for closing, and the
   * meter flushed at the end of the event. The viewers' pulled tracks close with their slots.
   */
  private endStream(streamId: string, reason: StreamEndReason, stopHelper = false): void {
    const stream = this.store.stream(streamId);
    if (!stream) return;
    if (stopHelper) this.sendToDevice(stream.deviceId, 'stream.stop', { streamId, reason });
    const pub = this.store.publicationOfStream(streamId);
    if (pub) {
      this.closeLater(
        pub.sfu_session_id,
        pub.tracks.map((t) => t.mid),
      );
      this.store.deletePublication(pub.sfu_session_id);
    }
    this.store.deleteStream(streamId);
    this.pendingThumbnailDeletes.push(thumbnailKey(streamId));
    this.broadcast('stream.ended', { streamId, reason });
    this.flushPending = true;
    const room = this.store.room();
    writeStreamEnd(
      metricsDataset(this.env),
      { spaceId: room?.spaceId ?? null, roomId: room?.roomId ?? null, streamId },
      reason,
      Date.now() - stream.startedAt,
    );
  }

  private endStreamsOf(
    match: (s: RoomStream) => boolean,
    reason: StreamEndReason,
    stopHelper = false,
  ): void {
    for (const s of this.store.streams()) {
      if (match(s)) this.endStream(s.streamId, reason, stopHelper);
    }
  }

  private streamIdsOf(match: (s: RoomStream) => boolean): string[] {
    return this.store
      .streams()
      .filter(match)
      .map((s) => s.streamId);
  }

  // --- Voice channel (docs/PROTOCOL.md 7.5) ---

  private onVoiceJoin(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'voice.join'>,
    id?: MessageId,
  ): void {
    this.pruneVoice();
    const existing = this.store.voiceParticipant(me.userId);
    if (existing?.connection_id === me.connectionId) {
      send(ws, 'voice.joined', { participant: this.participantOf(existing) }, id);
      send(ws, 'voice.tracks', this.voiceTracksPayload(me.userId));
      return;
    }
    const limit = this.store.settings()?.maxVoiceParticipants ?? DEFAULT_MAX_VOICE_PARTICIPANTS;
    if (!existing && this.store.voiceParticipants().length >= limit) {
      return this.sendError(ws, { code: ErrorCode.VoiceFull, limit }, id);
    }
    const deafened = p.deafened ?? false;
    const muted = (p.muted ?? false) || deafened || !this.speakAllowed(me);
    if (existing) {
      // The voice moves to this tab: the old one loses its microphone and pulls.
      const hadMicrophone = this.dropVoiceMedia(me.userId);
      this.sendTo(existing.connection_id, 'voice.left', {
        userId: me.userId,
        reason: VoiceLeftReason.Moved,
      });
      const moved = { ...existing, connection_id: me.connectionId, muted, deafened };
      this.store.upsertVoiceParticipant(moved);
      send(ws, 'voice.joined', { participant: this.participantOf(moved) }, id);
      this.broadcastWeb('voice.updated', { participant: this.participantOf(moved) }, ws);
      if (hadMicrophone) this.sendVoiceTracks(me.userId);
    } else {
      const row: VoiceParticipantRow = {
        user_id: me.userId,
        connection_id: me.connectionId,
        muted,
        deafened,
        server_muted: this.store.serverMuted(me.userId),
        joined_at: Date.now(),
      };
      this.store.upsertVoiceParticipant(row);
      send(ws, 'voice.joined', { participant: this.participantOf(row) }, id);
      this.broadcastWeb('voice.joined', { participant: this.participantOf(row) }, ws);
    }
    send(ws, 'voice.tracks', this.voiceTracksPayload(me.userId));
  }

  /** From any tab of the user. Idempotent: not in voice, the reply alone. */
  private onVoiceLeave(ws: WebSocket, me: Attachment, id?: MessageId): void {
    this.leaveVoice(me.userId, VoiceLeftReason.Left, ws);
    send(ws, 'voice.left', { userId: me.userId, reason: VoiceLeftReason.Left }, id);
  }

  private onVoiceState(
    ws: WebSocket,
    me: Attachment,
    p: PayloadOf<'voice.state'>,
    id?: MessageId,
  ): void {
    const current = this.store.voiceParticipant(me.userId);
    if (!current) return this.sendError(ws, { code: ErrorCode.VoiceNotJoined }, id);
    const muted = p.muted || p.deafened;
    if (!muted && !this.speakAllowed(me)) {
      return this.sendError(ws, { code: ErrorCode.VoiceSpeakNotAllowed }, id);
    }
    const next = { ...current, muted, deafened: p.deafened };
    this.store.upsertVoiceParticipant(next);
    if (id) send(ws, 'ack', {}, id);
    this.broadcastWeb('voice.updated', { participant: this.participantOf(next) });
  }

  /** voice.serverMute (with `muted`) or voice.kick, under the rule of removing someone. */
  private onVoiceModerate(
    ws: WebSocket,
    me: Attachment,
    userId: string,
    id?: MessageId,
    muted?: boolean,
  ): void {
    if (!me.permissions.canModerate) return this.forbidden(ws, id);
    const target = this.store.voiceParticipant(userId);
    const targetSocket = target ? this.voiceAttachment(target) : null;
    if (!target || !targetSocket) {
      return this.sendError(ws, { code: ErrorCode.VoiceNotJoined, userId }, id);
    }
    const decision = canModerateVoiceAs(
      me.role,
      me.userId,
      this.store.settings()?.capabilities ?? STREAM_ONLY,
      { userId, role: targetSocket.role, invitedBy: null },
    );
    if (!decision.allowed) return this.forbidden(ws, id);
    if (muted === undefined) {
      this.leaveVoice(userId, VoiceLeftReason.Kicked);
    } else if (muted !== target.server_muted) {
      // Server mute closes the microphone at the SFU and refuses a new one until lifted.
      const track = muted ? this.store.voiceTrackOf(userId) : null;
      if (track) this.closeMicrophone(track);
      const next = { ...target, server_muted: muted };
      this.store.upsertVoiceParticipant(next);
      this.store.setServerMuted(userId, muted);
      this.broadcastWeb('voice.updated', { participant: this.participantOf(next) });
      if (track) this.sendVoiceTracks(userId);
    }
    if (id) send(ws, 'ack', {}, id);
  }

  /**
   * Takes a user out of voice: their microphone and pulls close, everyone hears voice.left (the
   * `except` socket gets it as its reply instead) and the others' voice.tracks lose the microphone.
   * Returns whether they were in voice.
   */
  private leaveVoice(userId: string, reason: VoiceLeftReason, except?: WebSocket): boolean {
    if (!this.store.voiceParticipant(userId)) return false;
    const hadMicrophone = this.dropVoiceMedia(userId);
    this.store.deleteVoiceParticipant(userId);
    this.broadcastWeb('voice.left', { userId, reason }, except);
    if (hadMicrophone) this.sendVoiceTracks();
    return true;
  }

  /**
   * Closes a user's microphone, camera and every voice and camera pull they hold. Returns whether
   * a microphone or a camera closed (the others' voice.tracks changed).
   */
  private dropVoiceMedia(userId: string): boolean {
    for (const pull of this.store.takeVoicePulls({ userId })) {
      this.closeLater(pull.session_id, [pull.mid]);
    }
    for (const pull of this.store.takeCameraPulls({ userId })) {
      this.closeLater(pull.session_id, [pull.mid]);
    }
    const track = this.store.voiceTrackOf(userId);
    if (track) this.closeMicrophone(track);
    const camera = this.store.cameraTrackOf(userId);
    if (camera) this.closeCamera(camera);
    return track !== null || camera !== null;
  }

  /**
   * Closes a microphone at the SFU and every pull of it; the caller sends voice.tracks. The
   * listeners stop their transceivers when the track leaves their list.
   */
  private closeMicrophone(track: VoiceTrackRow): void {
    this.accrueNow();
    for (const pull of this.store.takeVoicePulls({ trackId: track.track_id })) {
      this.closeLater(pull.session_id, [pull.mid]);
    }
    this.closeLater(track.session_id, [track.mid]);
    this.store.deleteVoiceTrack(track.track_id);
  }

  /** Someone who lost the right to speak (role, guestsCanSpeak) is muted and their mic closed. */
  private enforceSpeak(a: Attachment): void {
    const p = this.store.voiceParticipant(a.userId);
    if (!p || this.speakAllowed(a)) return;
    const track = this.store.voiceTrackOf(a.userId);
    if (track) this.closeMicrophone(track);
    if (!p.muted) {
      const next = { ...p, muted: true };
      this.store.upsertVoiceParticipant(next);
      this.broadcastWeb('voice.updated', { participant: this.participantOf(next) });
    }
    if (track) this.sendVoiceTracks(a.userId);
  }

  /** Drops participants whose tab is gone without a close event (a restart), with voice.left. */
  private pruneVoice(): void {
    const open = new Set(this.present().map(({ a }) => a.connectionId));
    for (const p of this.store.voiceParticipants()) {
      if (!open.has(p.connection_id)) this.leaveVoice(p.user_id, VoiceLeftReason.Disconnected);
    }
  }

  /** The attachment of the tab a participant is in voice from. */
  private voiceAttachment(p: VoiceParticipantRow): Attachment | null {
    for (const ws of this.ctx.getWebSockets(connTag(p.connection_id))) {
      const a = attachmentOf(ws);
      if (!a.closing) return a;
    }
    return null;
  }

  private speakAllowed(a: Attachment): boolean {
    const settings = this.store.settings();
    return canSpeakAs(
      a.role,
      settings?.capabilities ?? STREAM_ONLY,
      settings?.guestsCanSpeak ?? true,
    ).allowed;
  }

  /** The others' microphones, as `userId` sees them in voice.tracks. */
  private voiceTracksFor(userId: string): VoiceTrack[] {
    return this.store
      .voiceTracks()
      .filter((t) => t.user_id !== userId)
      .map((t) => ({ trackId: t.track_id, userId: t.user_id }));
  }

  /** voice.tracks for `userId`: the others' microphones, and their cameras in a room with cameras. */
  private voiceTracksPayload(userId: string): PayloadOf<'voice.tracks'> {
    const tracks = this.voiceTracksFor(userId);
    if (!this.cameraCapability()) return { tracks };
    const cameras: CameraTrack[] = this.store
      .cameraTracks()
      .filter((t) => t.user_id !== userId)
      .map((t) => ({ trackId: t.track_id, userId: t.user_id, rids: t.rids }));
    return { tracks, cameras };
  }

  /** voice.tracks to every tab in voice (but `except`'s, whose own list did not change). */
  private sendVoiceTracks(exceptUserId?: string): void {
    for (const p of this.store.voiceParticipants()) {
      if (p.user_id === exceptUserId) continue;
      this.sendTo(p.connection_id, 'voice.tracks', this.voiceTracksPayload(p.user_id));
    }
  }

  // --- Cameras in the voice channel (docs/PROTOCOL.md 7.7) ---

  /** A participant as everyone sees them, with their camera. */
  private participantOf(p: VoiceParticipantRow): VoiceParticipant {
    return participant(p, this.store.cameraTrackOf(p.user_id) !== null);
  }

  /** voice.cameraOff, under the rule of removing someone. Already off: ack. */
  private onCameraOff(ws: WebSocket, me: Attachment, userId: string, id?: MessageId): void {
    if (!me.permissions.canModerate) return this.forbidden(ws, id);
    const target = this.store.voiceParticipant(userId);
    const targetSocket = target ? this.voiceAttachment(target) : null;
    if (!target || !targetSocket) {
      return this.sendError(ws, { code: ErrorCode.VoiceNotJoined, userId }, id);
    }
    const decision = canModerateCameraAs(
      me.role,
      me.userId,
      this.store.settings()?.capabilities ?? STREAM_ONLY,
      { userId, role: targetSocket.role, invitedBy: null },
    );
    if (!decision.allowed) return this.forbidden(ws, id);
    this.turnCameraOff(userId, CameraStopReason.Moderator);
    if (id) send(ws, 'ack', {}, id);
  }

  /**
   * Turns a user's camera off: closed at the SFU with its pulls, everyone sees `camera` go away,
   * the others' voice.tracks lose it, and with a reason the owner's tab hears voice.cameraStopped.
   */
  private turnCameraOff(userId: string, reason: CameraStopReason | null): void {
    const track = this.store.cameraTrackOf(userId);
    if (!track) return;
    this.closeCamera(track);
    const p = this.store.voiceParticipant(userId);
    if (!p) return;
    if (reason) this.sendTo(p.connection_id, 'voice.cameraStopped', { reason });
    this.broadcastWeb('voice.updated', { participant: this.participantOf(p) });
    this.sendVoiceTracks(userId);
  }

  /** Closes a camera at the SFU and every pull of it; the caller tells the room. */
  private closeCamera(track: CameraTrackRow): void {
    this.accrueNow();
    for (const pull of this.store.takeCameraPulls({ trackId: track.track_id })) {
      this.closeLater(pull.session_id, [pull.mid]);
    }
    this.closeLater(track.session_id, [track.mid]);
    this.store.deleteCameraTrack(track.track_id);
  }

  /**
   * Turns off the cameras the room no longer allows: the capability went away, their owner may no
   * longer use one (role, guestsCanUseCamera), or maxCameras went below the cameras on (the newest
   * ones go first).
   */
  private enforceCameras(): void {
    const cameras = this.store.cameraTracks();
    if (cameras.length === 0) return;
    if (!this.cameraCapability()) {
      for (const t of cameras) this.turnCameraOff(t.user_id, CameraStopReason.CapabilityDisabled);
      return;
    }
    const kept: CameraTrackRow[] = [];
    for (const t of cameras) {
      const p = this.store.voiceParticipant(t.user_id);
      const a = p ? this.voiceAttachment(p) : null;
      if (a && !this.cameraAllowed(a.role)) {
        this.turnCameraOff(t.user_id, CameraStopReason.NotAllowed);
      } else {
        kept.push(t);
      }
    }
    const limit = this.store.settings()?.maxCameras ?? DEFAULT_MAX_CAMERAS;
    for (const t of kept.slice(limit)) this.turnCameraOff(t.user_id, CameraStopReason.Limit);
  }

  private cameraAllowed(role: Role): boolean {
    const settings = this.store.settings();
    return canUseCameraAs(
      role,
      settings?.capabilities ?? STREAM_ONLY,
      settings?.guestsCanUseCamera ?? false,
    ).allowed;
  }

  // --- Slots and queue ---

  private onSlotRequest(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    const stream = this.store.stream(streamId);
    if (!stream) return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId }, id);
    const held = this.store.slotOf(me.connectionId, streamId);
    if (held) return this.renewAndGrant(ws, held, id);
    const limit = this.limitOf(stream);
    const used = this.store.reserved(streamId);
    if (used >= limit) {
      return this.sendError(ws, { code: ErrorCode.ViewerLimitReached, streamId, limit, used }, id);
    }
    const before = this.store.positions(streamId);
    this.grant(ws, me, streamId, id);
    this.settle(streamId, before);
  }

  private onSlotRenew(ws: WebSocket, me: Attachment, slotId: string, id?: MessageId): void {
    const slot = this.ownSlot(me, slotId);
    if (!slot) return this.sendError(ws, { code: ErrorCode.SlotNotFound, slotId }, id);
    const expiresAt = Date.now() + LEASE_MS;
    this.store.renewSlot(slotId, expiresAt);
    send(ws, 'slot.renewed', { slotId, expiresAt }, id);
  }

  private onSlotRelease(ws: WebSocket, me: Attachment, slotId: string, id?: MessageId): void {
    const slot = this.ownSlot(me, slotId);
    if (!slot) return this.sendError(ws, { code: ErrorCode.SlotNotFound, slotId }, id);
    const before = this.store.positions(slot.stream_id);
    this.store.deleteSlot(slotId);
    send(
      ws,
      'slot.released',
      { slotId, streamId: slot.stream_id, reason: SlotReleaseReason.Released },
      id,
    );
    this.settle(slot.stream_id, before);
  }

  private onQueueJoin(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    const stream = this.store.stream(streamId);
    if (!stream) return this.sendError(ws, { code: ErrorCode.StreamNotFound, streamId }, id);
    const held = this.store.slotOf(me.connectionId, streamId);
    if (held) return this.renewAndGrant(ws, held, id);
    const before = this.store.positions(streamId);
    if (!this.store.queueEntry(me.connectionId, streamId)) {
      if (this.store.reserved(streamId) < this.limitOf(stream)) {
        // A slot is free (and, since free slots are always offered, nobody is waiting).
        this.grant(ws, me, streamId, id);
        this.settle(streamId, before);
        return;
      }
      this.store.enqueue({
        stream_id: streamId,
        user_id: me.userId,
        connection_id: me.connectionId,
        priority: queuePriority(me.role),
      });
    }
    const after = this.store.positions(streamId);
    send(
      ws,
      'queue.position',
      { streamId, position: after.get(me.connectionId) ?? 1, length: after.size },
      id,
    );
    this.settle(streamId, before, me.connectionId);
  }

  private onQueueAccept(ws: WebSocket, me: Attachment, offerId: string, id?: MessageId): void {
    const entry = this.store.offer(offerId);
    if (
      !entry ||
      entry.connection_id !== me.connectionId ||
      (entry.offer_expires_at ?? 0) <= Date.now()
    ) {
      return this.sendError(ws, { code: ErrorCode.OfferNotFound, offerId }, id);
    }
    const before = this.store.positions(entry.stream_id);
    this.store.dequeue(entry.seq);
    this.grant(ws, me, entry.stream_id, id);
    this.settle(entry.stream_id, before);
  }

  private onQueueLeave(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    const entry = this.store.queueEntry(me.connectionId, streamId);
    if (entry) {
      const before = this.store.positions(streamId);
      this.store.dequeue(entry.seq);
      this.settle(streamId, before);
    }
    if (id) send(ws, 'ack', {}, id);
  }

  private grant(ws: WebSocket, me: Attachment, streamId: string, id?: MessageId): void {
    const slot: SlotRow = {
      slot_id: newId('sl'),
      stream_id: streamId,
      user_id: me.userId,
      connection_id: me.connectionId,
      expires_at: Date.now() + LEASE_MS,
    };
    this.store.insertSlot(slot);
    const entry = this.store.queueEntry(me.connectionId, streamId);
    if (entry) this.store.dequeue(entry.seq);
    send(
      ws,
      'slot.granted',
      { slotId: slot.slot_id, streamId, expiresAt: slot.expires_at, leaseMs: LEASE_MS },
      id,
    );
  }

  private renewAndGrant(ws: WebSocket, slot: SlotRow, id?: MessageId): void {
    const expiresAt = Date.now() + LEASE_MS;
    this.store.renewSlot(slot.slot_id, expiresAt);
    send(
      ws,
      'slot.granted',
      { slotId: slot.slot_id, streamId: slot.stream_id, expiresAt, leaseMs: LEASE_MS },
      id,
    );
  }

  /**
   * After any change to a stream's slots or queue: offer free slots to the head of the queue,
   * tell queued connections whose position moved, and broadcast viewers.
   */
  private settle(streamId: string, before: Map<string, number>, skip?: string): void {
    const stream = this.store.stream(streamId);
    if (stream) {
      let free = this.limitOf(stream) - this.store.reserved(streamId);
      for (const entry of this.store.queue(streamId)) {
        if (free <= 0) break;
        if (entry.offer_id) continue;
        const offerId = newId('of');
        const expiresAt = Date.now() + OFFER_MS;
        this.store.setOffer(entry.seq, offerId, expiresAt);
        this.sendTo(entry.connection_id, 'queue.offer', { streamId, offerId, expiresAt });
        free--;
      }
    }
    this.notifyPositions(streamId, before, skip);
    this.broadcastViewers(streamId);
  }

  private notifyPositions(streamId: string, before: Map<string, number>, skip?: string): void {
    const after = this.store.positions(streamId);
    for (const [connectionId, position] of after) {
      if (connectionId === skip || before.get(connectionId) === position) continue;
      this.sendTo(connectionId, 'queue.position', { streamId, position, length: after.size });
    }
  }

  private broadcastViewers(streamId: string): void {
    const stream = this.store.stream(streamId);
    if (!stream) return;
    const slots = this.store.slotsOf(streamId);
    this.broadcast('viewers', {
      streamId,
      viewerUserIds: [...new Set(slots.map((s) => s.user_id))],
      used: slots.length,
      limit: this.limitOf(stream),
      queueLength: this.store.queue(streamId).length,
    });
  }

  /** The stream's own limit, never above the room's effective limit. */
  private limitOf(stream: RoomStream): number {
    const room = this.store.settings()?.maxViewersPerStream ?? stream.viewerLimit;
    return Math.min(stream.viewerLimit, room);
  }

  private streamInfo(stream: RoomStream): StreamInfo {
    const cap = this.qualityCap();
    return {
      ...stream,
      viewerLimit: this.limitOf(stream),
      viewerCount: this.store.slotsOf(stream.streamId).length,
      ...(cap ? { qualityCap: cap } : {}),
    };
  }

  private ownSlot(me: Attachment, slotId: string): SlotRow | null {
    const slot = this.store.slot(slotId);
    return slot && slot.connection_id === me.connectionId ? slot : null;
  }

  private queuedStreams(connectionId: string): string[] {
    const streams = this.store.streams().map((s) => s.streamId);
    return streams.filter((s) => this.store.queueEntry(connectionId, s));
  }

  /**
   * Sets the alarm to the earliest deadline, but only moves it earlier: setAlarm is a write, and
   * deadlines that move later all the time (leases, the presence refresh) would rewrite it on
   * every event. An alarm left earlier than needed fires, finds nothing due and is set again.
   *
   * From the alarm (`handledAt`, when it started), a deadline due by then is one the handler did
   * not clear: re-arming it at once would fire the alarm again and again (an expired quick room
   * once did, burning the quota), so it is retried STUCK_DEADLINE_RETRY_MS later (alarmTarget).
   */
  private async scheduleAlarm(handledAt: number | null): Promise<void> {
    if (this.dormancy.active) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    // A tripped object is not re-armed until the cool-down ends (do/breaker.ts).
    if (this.breaker.isOpen()) return;
    const lease = this.store.nextLeaseExpiry();
    const deadlines = [
      this.store.nextDeadline(),
      lease === null || this.store.anyQueued() ? lease : nextTick(lease - 1),
      this.pendingExpiry(),
      this.store.getNumber(METER_DUE_KEY),
      this.presenceDue,
      this.chat.nextDeadline(),
    ].filter((t): t is number => t !== null);
    const current = await this.ctx.storage.getAlarm();
    if (deadlines.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const earliest = Math.min(...deadlines);
    const next = alarmTarget(earliest, handledAt, now);
    if (next !== earliest) {
      console.error('room alarm: a deadline is still due after the alarm', {
        roomId: this.store.room()?.roomId ?? null,
        next: earliest,
      });
    }
    // An alarm already due (the one being handled, if the runtime still reports it) is re-armed.
    if (current === null || next < current || (current <= now && next > current)) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  // --- Connections and sending ---

  /** Open sockets that completed hello and are not being closed. */
  private present(): { ws: WebSocket; a: Attachment }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, a: attachmentOf(ws) }))
      .filter(({ ws, a }) => a.hello && !a.closing && ws.readyState === WebSocket.OPEN);
  }

  private presentUsers(): Set<string> {
    return new Set(this.present().map(({ a }) => a.userId));
  }

  private presentMembers(): Member[] {
    const byUser = new Map<string, Member>();
    for (const { a } of this.present()) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, member(a));
    }
    return [...byUser.values()];
  }

  private userSockets(userId: string): WebSocket[] {
    return this.ctx.getWebSockets(userTag(userId)).filter((ws) => !attachmentOf(ws).closing);
  }

  /** Open helper sockets of a device. */
  private helperSockets(deviceId: string): WebSocket[] {
    return this.present()
      .filter(({ a }) => a.hello?.client === 'helper' && a.deviceId === deviceId)
      .map(({ ws }) => ws);
  }

  /** Open sockets of a web tab (hello.tabId) of a user. */
  private tabSockets(userId: string, tabId: string): WebSocket[] {
    return this.present()
      .filter(
        ({ a }) => a.hello?.client === 'web' && a.userId === userId && a.hello.tabId === tabId,
      )
      .map(({ ws }) => ws);
  }

  /**
   * Sends to the publisher of a stream's device id: the helper's sockets, or for a browser
   * publication's own id the sockets of its tab (since 1.22).
   */
  private sendToDevice<T extends MessageType>(
    deviceId: string,
    type: T,
    payload: PayloadOf<T>,
  ): void {
    const pub = this.store.browserPublicationOfDevice(deviceId);
    const sockets =
      pub?.tab_id != null ? this.tabSockets(pub.user_id, pub.tab_id) : this.helperSockets(deviceId);
    for (const ws of sockets) send(ws, type, payload);
  }

  private sendTo<T extends MessageType>(
    connectionId: string,
    type: T,
    payload: PayloadOf<T>,
  ): void {
    for (const ws of this.ctx.getWebSockets(connTag(connectionId))) {
      if (!attachmentOf(ws).closing) send(ws, type, payload);
    }
  }

  private broadcast<T extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    except?: WebSocket,
  ): void {
    const frame = encodeMessage(type, payload);
    for (const { ws } of this.present()) {
      if (ws !== except) sendFrame(ws, frame);
    }
  }

  /** Like broadcast, to web connections only (voice: the helper never needs it). */
  private broadcastWeb<T extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    except?: WebSocket,
  ): void {
    const frame = encodeMessage(type, payload);
    for (const { ws, a } of this.present()) {
      if (ws !== except && a.hello?.client === 'web') sendFrame(ws, frame);
    }
  }

  /** Whether the room has the stream capability; a server before 1.8 stored none (stream-only). */
  private streamCapability(): boolean {
    return this.store.settings()?.capabilities?.stream ?? true;
  }

  /** Whether the room has cameras (which need voice); a room that stored none is stream-only. */
  private cameraCapability(): boolean {
    const capabilities = this.store.settings()?.capabilities;
    return (capabilities?.voice ?? false) && (capabilities?.camera ?? false);
  }

  /** Whether the room has the voice capability; a room that stored none is stream-only. */
  private voiceCapability(): boolean {
    return this.store.settings()?.capabilities?.voice ?? false;
  }

  /** Whether the room has the text chat; a room that stored none is stream-only. */
  private textCapability(): boolean {
    return this.store.settings()?.capabilities?.text ?? false;
  }

  /** First message of a user here: remembered in D1 for account deletion (chat_authors). */
  private async recordChatAuthor(userId: string): Promise<void> {
    const roomId = this.store.room()?.roomId;
    if (!roomId) return;
    await this.env.DB.prepare(
      'INSERT OR IGNORE INTO chat_authors (room_id, user_id, first_at) VALUES (?, ?, ?)',
    )
      .bind(roomId, userId, Date.now())
      .run();
  }

  /** The stream's start in D1, for the mobile app's "what happened" summary (PROTOCOL.md 11.7). */
  private async recordStreamStart(stream: RoomStream): Promise<void> {
    const room = this.store.room();
    if (!room) return;
    try {
      const db = this.env.DB;
      // The week-old rows go with each new start, a few at a time: no sweep needed.
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO stream_starts (stream_id, space_id, room_id, user_id, started_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(stream.streamId, room.spaceId, room.roomId, stream.userId, stream.startedAt),
        db
          .prepare(
            `DELETE FROM stream_starts WHERE rowid IN
               (SELECT rowid FROM stream_starts WHERE started_at < ? LIMIT 20)`,
          )
          .bind(stream.startedAt - STREAM_STARTS_KEEP_MS),
      ]);
    } catch (err) {
      console.error('stream_starts insert failed', err);
    }
  }

  /** The hub notice of a mention (docs/PROTOCOL.md 7.6), to every web tab of the user. */
  private async notifyMention(userId: string, authorId: string): Promise<void> {
    const roomId = this.store.room()?.roomId;
    if (!roomId) return;
    const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId));
    try {
      await hub.notice({ event: EventCode.ChatMention, roomId, userId: authorId });
    } catch {
      // A notice is best effort; the message itself already went out.
    }
  }

  /** A connection's You, with its voice permissions computed from the room's current settings. */
  private you(a: Attachment): You {
    const settings = this.store.settings();
    const capabilities = settings?.capabilities ?? STREAM_ONLY;
    return {
      userId: a.userId,
      connectionId: a.connectionId,
      role: a.role,
      permissions: {
        ...a.permissions,
        canJoinVoice: canJoinVoiceAs(capabilities).allowed,
        canSpeak: canSpeakAs(a.role, capabilities, settings?.guestsCanSpeak ?? true).allowed,
        canUseCamera: this.cameraAllowed(a.role),
        canReadChat: canReadChatAs(capabilities).allowed,
        canWriteChat: canWriteChatAs(a.role, capabilities, settings?.guestsCanWrite ?? true)
          .allowed,
      },
    };
  }

  private sendError(ws: WebSocket, error: PayloadOf<'error'>, id?: MessageId): void {
    send(ws, 'error', error, id);
  }

  private forbidden(ws: WebSocket, id?: MessageId): void {
    const roomId = this.store.room()?.roomId;
    this.sendError(ws, { code: ErrorCode.Forbidden, ...(roomId ? { roomId } : {}) }, id);
  }
}

/**
 * The video track a viewer pulls: the AV1 one when it asks for AV1, the stream has
 * one and the room allows AV1 for the stream's preset; else the H.264 one.
 */
export function pulledVideo(
  tracks: readonly PublishedTrackRow[],
  wanted: VideoCodec | undefined,
  preset: Preset,
  settings: RoomSettings,
): PublishedTrackRow | undefined {
  const videos = tracks.filter((t) => t.kind === 'video');
  const av1 = videos.find((t) => t.codec === VideoCodec.Av1);
  if (wanted === VideoCodec.Av1 && av1 && (settings.av1Presets ?? []).includes(preset)) return av1;
  return videos.find((t) => (t.codec ?? VideoCodec.H264) === VideoCodec.H264) ?? videos[0];
}

/**
 * Announced layers (since 1.19) describe the H.264 video track: one per rid, in its order, or a
 * single one when that track is not simulcast.
 */
export function layersMatch(
  layers: readonly VideoLayer[],
  tracks: readonly PublishedTrackRow[],
): boolean {
  const video = tracks.find(
    (t) => t.kind === 'video' && (t.codec ?? VideoCodec.H264) === VideoCodec.H264,
  );
  if (!video) return false;
  const rids = video.rids ?? [];
  if (rids.length === 0) return layers.length === 1;
  return layers.length === rids.length && layers.every((l, i) => l.rid === rids[i]);
}

/** A publisher track as tracks/new or tracks/update pull it onto a viewer session. */
function remoteTrack(
  publisherSessionId: string,
  track: PublishedTrackRow,
  rid: string | null,
): SfuTrack {
  return {
    location: 'remote',
    sessionId: publisherSessionId,
    trackName: track.name,
    // Start on the requested (default: high) layer; never let the SFU pick.
    ...(track.kind === 'video' && track.rids?.length && rid
      ? {
          simulcast: {
            preferredRid: rid,
            priorityOrdering: 'none' as const,
            ridNotAvailable: 'asciibetical' as const,
          },
        }
      : {}),
  };
}

/**
 * Whether a publication is the caller's: a helper's of that device (`deviceId`), or the caller's
 * browser publication (`deviceId` null, since 1.22).
 */
function ownsPublication(
  pub: { user_id: string; device_id: string; tab_id: string | null },
  userId: string,
  deviceId: string | null,
): boolean {
  if (pub.user_id !== userId) return false;
  return deviceId === null
    ? pub.tab_id !== null
    : pub.tab_id === null && pub.device_id === deviceId;
}

function attachmentOf(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function send<T extends MessageType>(
  ws: WebSocket,
  type: T,
  payload: PayloadOf<T>,
  id?: MessageId,
): void {
  sendFrame(ws, encodeMessage(type, payload, id));
}

function sendFrame(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // The socket closed meanwhile; its close handler cleans up.
  }
}

function member(a: Attachment): Member {
  return {
    userId: a.userId,
    displayName: a.displayName,
    role: a.role,
    canStream: a.permissions.canStream,
    ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
  };
}

/** `camera` is only sent while on (since 1.12): absent means off. */
function participant(p: VoiceParticipantRow, camera: boolean): VoiceParticipant {
  return {
    userId: p.user_id,
    muted: p.muted,
    deafened: p.deafened,
    serverMuted: p.server_muted,
    ...(camera ? { camera: true } : {}),
    joinedAt: p.joined_at,
  };
}

/** A camera as tracks/new or tracks/update pull it onto a viewer session, on layer `rid`. */
function remoteCamera(track: CameraTrackRow, rid: string | null): SfuTrack {
  return {
    location: 'remote',
    sessionId: track.session_id,
    trackName: track.track_name,
    ...(track.rids.length > 0 && rid
      ? {
          simulcast: {
            preferredRid: rid,
            priorityOrdering: 'none' as const,
            ridNotAvailable: 'asciibetical' as const,
          },
        }
      : {}),
  };
}

// Every RPC method counts as a request and is refused while the breaker is open (do/breaker.ts).
guardRpc(RoomDO, [
  'upsertStream',
  'checkSlot',
  'kick',
  'streamsOf',
  'revokeAccess',
  'revokeDevice',
  'revokeApp',
  'closeRoom',
  'visibilityChanged',
  'setExpiry',
  'permissionsChanged',
  'settingsChanged',
  'flushUsage',
  'chatUnread',
  'chatCounts',
  'eraseChatAuthor',
  'liveStreamIds',
  'putThumbnail',
  'rtcPublish',
  'rtcBrowserPublish',
  'rtcPublishRenegotiate',
  'rtcUnpublish',
  'rtcViewerSession',
  'rtcSubscribe',
  'rtcViewerRenegotiate',
  'rtcLayer',
  'rtcUnsubscribe',
  'rtcLeave',
  'rtcVoicePublish',
  'rtcVoiceUnpublish',
  'rtcVoiceSubscribe',
  'rtcVoiceUnsubscribe',
  'rtcCameraPublish',
  'rtcCameraUnpublish',
  'rtcCameraSubscribe',
  'rtcCameraLayer',
  'rtcCameraUnsubscribe',
]);
