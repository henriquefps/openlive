// SPDX-License-Identifier: AGPL-3.0-only
import {
  CloseCode,
  ErrorCode,
  encodeMessage,
  type MessageId,
  type MessageType,
  type PayloadOf,
  parseMessage,
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
  type RoomPresence,
  type RoomVisibility,
} from '@openlive/protocol';
import { DurableObject } from 'cloudflare:workers';
import { CONNECT_PATH, decodeConnectContext } from '../room/connect';
import { maySee, presenceAccess } from '../space/access';
import type { RoomPresenceUpdate, SpaceAttachment, SpaceConnectContext } from '../space/types';

const MAX_FRAME_CHARS = 64 * 1024;
const MIN_PROTOCOL = { major: 1, minor: 0 } as const;
/**
 * A summary not refreshed for this long is dropped: its RoomDO stopped without a close event
 * (a deploy). Rooms with someone in them push again every PRESENCE_REFRESH_MS (do/room.ts).
 */
export const PRESENCE_TTL_MS = 25 * 60_000;

const userTag = (userId: string) => `u:${userId}`;
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

const CLOSE_REASONS: Record<number, string> = {
  [CloseCode.Normal]: 'normal',
  [CloseCode.Unauthenticated]: 'unauthenticated',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.Forbidden]: 'forbidden',
  [CloseCode.ProtocolUnsupported]: 'protocol_unsupported',
};

interface PresenceRow extends Record<string, SqlStorageValue> {
  room_id: string;
  visibility: RoomVisibility;
  summary: string;
  updated_at: number;
}

/**
 * One instance per space (idFromName(spaceId)): the room presence of the space sidebar
 * (docs/PROTOCOL.md 7.8). Each RoomDO of the space pushes its summary (who is in voice, who
 * streams) when it changes; the SpaceDO keeps the latest non-empty one per room in its SQLite and
 * relays it to the web tabs showing the space, each only the rooms it may view.
 *
 * Its sockets are web tabs only, and it never answers anything but hello, so it sleeps between
 * pushes (WebSocket Hibernation; pings are answered by the runtime).
 */
export class SpaceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_presence (
         room_id    TEXT PRIMARY KEY,
         visibility TEXT NOT NULL,
         summary    TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json({ ok: true, object: 'SpaceDO' });
    }
    if (pathname !== CONNECT_PATH) {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    const context = decodeConnectContext<SpaceConnectContext>(request);
    if (!context || request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ code: ErrorCode.InvalidMessage, path: '' }, { status: 400 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: SpaceAttachment = { ...context, connectionId: newId('c') };
    this.ctx.acceptWebSocket(server, [userTag(context.userId)]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- WebSocket events ---

  override webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer): void {
    const me = attachmentOf(ws);
    if (me.closing) return;
    if (typeof frame !== 'string' || frame.length > MAX_FRAME_CHARS) {
      sendError(ws, { code: ErrorCode.InvalidMessage, path: '' });
      return;
    }
    const parsed = parseMessage(frame);
    if (!parsed.ok) {
      // Unknown types are ignored unless they asked for a reply (PROTOCOL.md section 1).
      if (parsed.error.code === ErrorCode.UnknownMessageType && !parsed.id) return;
      sendError(ws, parsed.error, parsed.id);
      return;
    }
    const msg = parsed.message;
    if (!me.hello) {
      if (msg.type === 'hello') this.onHello(ws, me, msg.payload, msg.id);
      else sendError(ws, { code: ErrorCode.HelloRequired, messageType: msg.type }, msg.id);
      return;
    }
    if (msg.type === 'hello') {
      sendError(ws, { code: ErrorCode.InvalidMessage, path: '/type' }, msg.id);
      return;
    }
    // Nothing else is served here: same rule as an unknown type.
    if (msg.id) {
      sendError(ws, { code: ErrorCode.UnknownMessageType, messageType: msg.type }, msg.id);
    }
  }

  override webSocketClose(ws: WebSocket): void {
    this.disconnect(ws, CloseCode.Normal);
  }

  override webSocketError(ws: WebSocket): void {
    this.disconnect(ws, CloseCode.Normal);
  }

  /** Drops the summaries whose RoomDO stopped refreshing them. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const stale = this.ctx.storage.sql
      .exec<PresenceRow>(
        'DELETE FROM room_presence WHERE updated_at <= ? RETURNING *',
        now - PRESENCE_TTL_MS,
      )
      .toArray();
    for (const row of stale) {
      this.relay(row.room_id, row.visibility, null, emptyPresence(row.room_id), now);
    }
    await this.scheduleAlarm();
  }

  // --- RPC for the RoomDOs and the Worker ---

  /**
   * A RoomDO's summary changed (or is refreshed). Empty lists mean the room is quiet: the summary
   * is forgotten, and whoever saw it gets the empty one.
   */
  async roomPresence(update: RoomPresenceUpdate): Promise<void> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const before = sql
      .exec<PresenceRow>('SELECT * FROM room_presence WHERE room_id = ?', update.roomId)
      .toArray()[0];
    const room: RoomPresence = { roomId: update.roomId, voice: update.voice, live: update.live };
    const summary = JSON.stringify(room);
    if (room.voice.length === 0 && room.live.length === 0) {
      if (!before) return;
      sql.exec('DELETE FROM room_presence WHERE room_id = ?', update.roomId);
    } else {
      sql.exec(
        `INSERT INTO room_presence (room_id, visibility, summary, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id) DO UPDATE SET visibility = excluded.visibility,
           summary = excluded.summary, updated_at = excluded.updated_at`,
        update.roomId,
        update.visibility,
        summary,
        now,
      );
    }
    // A refresh of the same summary only moves updated_at.
    if (before?.summary !== summary || before.visibility !== update.visibility) {
      this.relay(update.roomId, update.visibility, before?.visibility ?? null, room, now);
    }
    await this.scheduleAlarm();
  }

  /**
   * `userId`'s role or room access changed in D1 (api/sync.ts): their sockets reload what they
   * may see and get a fresh space.presence, or are closed with 4003 when the space is no longer
   * theirs to view.
   */
  async accessChanged(spaceId: string, userId: string): Promise<void> {
    const sockets = this.ctx
      .getWebSockets(userTag(userId))
      .filter((ws) => !attachmentOf(ws).closing);
    if (sockets.length === 0) return;
    const result = await presenceAccess(this.env.DB, spaceId, userId);
    for (const ws of sockets) {
      const me = attachmentOf(ws);
      if (me.closing) continue;
      if (!result.ok) {
        sendError(ws, { code: ErrorCode.Forbidden });
        this.disconnect(ws, CloseCode.Forbidden);
        continue;
      }
      const updated: SpaceAttachment = { ...me, access: result.access };
      ws.serializeAttachment(updated);
      if (updated.hello) send(ws, 'space.presence', this.snapshot(updated));
    }
  }

  /**
   * An app token was revoked (docs/PROTOCOL.md 11.6): its sockets get error session_expired and
   * close with 4001.
   */
  async revokeApp(appTokenId: string): Promise<number> {
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => attachmentOf(ws).appTokenId === appTokenId && !attachmentOf(ws).closing);
    for (const ws of sockets) {
      sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    return sockets.length;
  }

  // --- Handshake ---

  private onHello(
    ws: WebSocket,
    me: SpaceAttachment,
    hello: PayloadOf<'hello'>,
    id: MessageId | undefined,
  ): void {
    if (hello.protocol.major !== PROTOCOL_VERSION.major) {
      sendError(
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
    // The route refuses device tokens; a cookie connection may not claim to be a helper either.
    if (hello.client !== 'web') {
      sendError(ws, { code: ErrorCode.Unauthenticated }, id);
      this.disconnect(ws, CloseCode.Unauthenticated);
      return;
    }
    const updated: SpaceAttachment = {
      ...me,
      hello: hello.tabId ? { tabId: hello.tabId } : {},
    };
    ws.serializeAttachment(updated);
    // A newer connection of the same tab replaces the older one (close 4002).
    if (hello.tabId) {
      for (const other of this.ctx.getWebSockets(userTag(me.userId))) {
        const a = attachmentOf(other);
        if (other !== ws && !a.closing && a.hello?.tabId === hello.tabId) {
          this.disconnect(other, CloseCode.Replaced);
        }
      }
    }
    send(ws, 'space.presence', this.snapshot(updated), id);
  }

  /** Closes a socket from the server side; also the handler for a client-side close. */
  private disconnect(ws: WebSocket, code: CloseCode): void {
    const me = attachmentOf(ws);
    if (me.closing) return;
    ws.serializeAttachment({ ...me, closing: true } satisfies SpaceAttachment);
    try {
      ws.close(code, CLOSE_REASONS[code]);
    } catch {
      // Already closed.
    }
  }

  // --- Presence ---

  /** space.presence for one subscriber: every summary it may see. */
  private snapshot(me: SpaceAttachment): PayloadOf<'space.presence'> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<PresenceRow>(
        'SELECT * FROM room_presence WHERE updated_at > ? ORDER BY room_id',
        now - PRESENCE_TTL_MS,
      )
      .toArray();
    return {
      spaceId: me.spaceId,
      protocol: PROTOCOL_VERSION,
      minProtocol: MIN_PROTOCOL,
      serverTime: now,
      rooms: rows
        .filter((r) => maySee(me.access, r.room_id, r.visibility, now))
        .map((r) => JSON.parse(r.summary) as RoomPresence),
    };
  }

  /**
   * space.presence.updated to the subscribers that may see the room now; those that could see it
   * before (it just became restricted) get it empty instead.
   */
  private relay(
    roomId: string,
    visibility: RoomVisibility,
    before: RoomVisibility | null,
    room: RoomPresence,
    now: number,
  ): void {
    const frame = encodeMessage('space.presence.updated', { room });
    let hidden: string | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (!a.hello || a.closing) continue;
      if (maySee(a.access, roomId, visibility, now)) {
        sendFrame(ws, frame);
      } else if (before !== null && maySee(a.access, roomId, before, now)) {
        hidden ??= encodeMessage('space.presence.updated', { room: emptyPresence(roomId) });
        sendFrame(ws, hidden);
      }
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ oldest: number | null }>('SELECT MIN(updated_at) AS oldest FROM room_presence')
      .toArray()[0];
    const oldest = row?.oldest ?? null;
    const current = await this.ctx.storage.getAlarm();
    if (oldest === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = oldest + PRESENCE_TTL_MS;
    // Only ever moved earlier (setAlarm is a write, and every refresh moves the oldest summary
    // later): an early alarm finds nothing stale and is set again.
    if (current === null || next < current || (current <= Date.now() && next > current)) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

const emptyPresence = (roomId: string): RoomPresence => ({ roomId, voice: [], live: [] });

function attachmentOf(ws: WebSocket): SpaceAttachment {
  return ws.deserializeAttachment() as SpaceAttachment;
}

function send<T extends MessageType>(
  ws: WebSocket,
  type: T,
  payload: PayloadOf<T>,
  id?: MessageId,
): void {
  sendFrame(ws, encodeMessage(type, payload, id));
}

function sendError(ws: WebSocket, error: PayloadOf<'error'>, id?: MessageId): void {
  send(ws, 'error', error, id);
}

function sendFrame(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // The socket closed meanwhile.
  }
}
