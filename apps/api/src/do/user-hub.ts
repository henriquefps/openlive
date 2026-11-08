// SPDX-License-Identifier: AGPL-3.0-only
import {
  CloseCode,
  ErrorCode,
  encodeMessage,
  type HelperInfo,
  type Message,
  type MessageId,
  type MessageType,
  type NoticePayload,
  type PayloadOf,
  parseMessage,
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
} from '@openlive/protocol';
import { DurableObject } from 'cloudflare:workers';
import type { AppTarget, HubAttachment, HubConnectContext } from '../hub/types';
import {
  BREAKER_CLOSE_CODE,
  BREAKER_CLOSE_REASON,
  CircuitBreaker,
  guardRpc,
  refusedUpgrade,
} from './breaker';
import {
  addHelperSample,
  emptyHelperWindow,
  HELPER_WINDOW_MS,
  type HelperWindow,
  metricsDataset,
  writeHelper,
} from '../metrics/points';
import { CONNECT_PATH, decodeConnectContext } from '../room/connect';
import { closeForBrake } from './limits-brake';

const MAX_FRAME_CHARS = 512 * 1024;
const MIN_PROTOCOL = { major: 1, minor: 0 } as const;
/** A command the helper has not answered in this long is forgotten (the tab gives up first). */
export const PENDING_TTL_MS = 60_000;
/** Thumbnails after helper.sources go to the asking tab for this long (PROTOCOL.md 8.2). */
export const THUMBNAIL_WINDOW_MS = 60_000;

const connTag = (connectionId: string) => `c:${connectionId}`;
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

const CLOSE_REASONS: Record<number, string> = {
  [CloseCode.Normal]: 'normal',
  [CloseCode.Unauthenticated]: 'unauthenticated',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.ProtocolUnsupported]: 'protocol_unsupported',
  [BREAKER_CLOSE_CODE]: BREAKER_CLOSE_REASON,
};

/** Web → helper commands (PROTOCOL.md 8.2). */
const COMMANDS = new Set<MessageType>([
  'helper.listSources',
  'helper.startStream',
  'helper.stopStream',
  'helper.pauseStream',
  'helper.setPreset',
  'helper.setVoiceOutput',
]);
type Command = Extract<
  Message,
  {
    type:
      | 'helper.listSources'
      | 'helper.startStream'
      | 'helper.stopStream'
      | 'helper.pauseStream'
      | 'helper.setPreset'
      | 'helper.setVoiceOutput';
  }
>;
const isCommand = (m: Message): m is Command => COMMANDS.has(m.type);

/** A command relayed to a helper, waiting for its reply. */
interface PendingRow extends Record<string, SqlStorageValue> {
  hub_id: string;
  device_id: string;
  helper_conn: string;
  tab_conn: string;
  /** The tab's own request id; null when the tab sent no id (no reply on success). */
  tab_msg_id: string | null;
  thumbnails: number;
}

/**
 * One instance per user (idFromName(userId)): the user hub of docs/PROTOCOL.md 8. Its sockets are
 * the user's web tabs and paired helpers. It tells the tabs which helpers are online, relays
 * commands from a tab to a helper and the helper's reply back to that tab (each side sees only its
 * own message ids), and relays helper status and stats to every tab.
 *
 * Source picker thumbnails go only to the tab that listed the sources and are never stored. The
 * DO's SQLite holds the commands in flight, the latest helper.status per helper (so a tab that
 * connects later knows the state), which tab gets a helper's thumbnails, and the rooms each
 * device opened a socket in (for revocation).
 */
export class UserHubDO extends DurableObject<Env> {
  /**
   * helper.stats of each live stream, summed until they are written as one Analytics Engine
   * point. Memory only: a window lost to an eviction is a gap in the graphs, nothing
   * more.
   */
  private readonly helperWindows = new Map<
    string,
    { deviceId: string; roomId: string; window: HelperWindow }
  >();
  /** Room → space, for the points' space id (rooms never move). */
  private readonly roomSpaces = new Map<string, string | null>();
  /**
   * Stops this object if it goes wild, see do/breaker.ts. Its metric names no id: a hub is one
   * user's.
   */
  private readonly breaker: CircuitBreaker;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.breaker = new CircuitBreaker(this, ctx, env, { object: 'UserHubDO' });
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS device_rooms (
         device_id TEXT NOT NULL,
         room_id   TEXT NOT NULL,
         seen_at   INTEGER NOT NULL,
         PRIMARY KEY (device_id, room_id)
       );
       CREATE TABLE IF NOT EXISTS app_targets (
         app_token_id TEXT NOT NULL,
         kind         TEXT NOT NULL,
         target_id    TEXT NOT NULL,
         seen_at      INTEGER NOT NULL,
         PRIMARY KEY (app_token_id, kind, target_id)
       );
       CREATE TABLE IF NOT EXISTS pending (
         hub_id      TEXT PRIMARY KEY,
         device_id   TEXT NOT NULL,
         helper_conn TEXT NOT NULL,
         tab_conn    TEXT NOT NULL,
         tab_msg_id  TEXT,
         thumbnails  INTEGER NOT NULL,
         created_at  INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS helper_status (
         device_id TEXT PRIMARY KEY,
         payload   TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS thumbnail_targets (
         device_id  TEXT PRIMARY KEY,
         tab_conn   TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json({ ok: true, object: 'UserHubDO' });
    }
    if (!this.breaker.enter('request')) return refusedUpgrade();
    if (pathname !== CONNECT_PATH) {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    const context = decodeConnectContext<HubConnectContext>(request);
    if (!context || request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ code: ErrorCode.InvalidMessage, path: '' }, { status: 400 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: HubAttachment = {
      connectionId: newId('c'),
      userId: context.userId,
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
      ...(context.device ? { device: context.device } : {}),
      ...(context.appTokenId ? { appTokenId: context.appTokenId } : {}),
    };
    this.ctx.acceptWebSocket(server, [connTag(attachment.connectionId)]);
    server.serializeAttachment(attachment);
    this.breaker.connected();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The limits brake engaged (the cron): sockets closed with 1013. The hub has no
   * alarm, and the Worker refuses new connections until the brake releases.
   */
  brakeSleep(): number {
    return closeForBrake(this.ctx);
  }

  // --- WebSocket events ---

  override webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer): void {
    const me = attachmentOf(ws);
    if (me.closing) return;
    if (!this.breaker.enter('message') || !this.breaker.socketMessage(me.connectionId)) {
      this.disconnect(ws, BREAKER_CLOSE_CODE);
      return;
    }
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
    if (me.hello.client === 'web' && isCommand(msg)) {
      this.onCommand(ws, me, msg);
      return;
    }
    if (me.hello.client === 'helper' && me.deviceId) {
      if (this.onHelperMessage(ws, me.deviceId, msg)) return;
    }
    // Valid but not served here (room messages, or the other side's messages): same rule as an
    // unknown type.
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

  // --- RPC for the Worker ---

  /** A device of this user opened a socket in a room. */
  async deviceJoinedRoom(deviceId: string, roomId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO device_rooms (device_id, room_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT (device_id, room_id) DO UPDATE SET seen_at = excluded.seen_at`,
      deviceId,
      roomId,
      Date.now(),
    );
  }

  /** The rooms a device has been in, forgotten at once (the device is being revoked). */
  async takeDeviceRooms(deviceId: string): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ room_id: string }>(
        'DELETE FROM device_rooms WHERE device_id = ? RETURNING room_id',
        deviceId,
      )
      .toArray()
      .map((r) => r.room_id);
  }

  /** The mobile app opened a socket in a room or a space with this app token. */
  async appJoined(appTokenId: string, kind: AppTarget['kind'], targetId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO app_targets (app_token_id, kind, target_id, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (app_token_id, kind, target_id) DO UPDATE SET seen_at = excluded.seen_at`,
      appTokenId,
      kind,
      targetId,
      Date.now(),
    );
  }

  /**
   * An app token was revoked (docs/PROTOCOL.md 11.6): its hub sockets get error session_expired
   * and close with 4001. Returns the rooms and spaces it opened sockets in, forgotten at once, so
   * the Worker can close those too.
   */
  async revokeApp(appTokenId: string): Promise<AppTarget[]> {
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a.appTokenId !== appTokenId || a.closing) continue;
      sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    return this.ctx.storage.sql
      .exec<{ kind: AppTarget['kind']; target_id: string }>(
        'DELETE FROM app_targets WHERE app_token_id = ? RETURNING kind, target_id',
        appTokenId,
      )
      .toArray()
      .map((r) => ({ kind: r.kind, id: r.target_id }));
  }

  /** A user notice (docs/PROTOCOL.md 8.3), e.g. a chat mention from a RoomDO, to every web tab. */
  async notice(payload: NoticePayload): Promise<void> {
    this.broadcastToTabs('notice', payload);
  }

  /**
   * A paired device was revoked (PROTOCOL.md 11.1): its hub socket gets error session_expired
   * and closes with 4001, and the tabs see it go offline.
   */
  async revokeDevice(deviceId: string): Promise<number> {
    const sockets = this.helperSockets(deviceId);
    for (const ws of sockets) {
      sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    return sockets.length;
  }

  /**
   * The account was banned or deleted: every socket, tabs and helpers, gets error
   * session_expired and closes with 4001. Returns the rooms its devices have been in, forgotten at
   * once, so the Worker can close those too.
   */
  async revokeAll(): Promise<string[]> {
    for (const { ws } of this.present()) {
      sendError(ws, { code: ErrorCode.SessionExpired });
      this.disconnect(ws, CloseCode.Unauthenticated);
    }
    // Sockets still before their hello are not "present", but must not survive either.
    for (const ws of this.ctx.getWebSockets()) this.disconnect(ws, CloseCode.Unauthenticated);
    const rooms = this.ctx.storage.sql
      .exec<{ room_id: string }>('DELETE FROM device_rooms RETURNING room_id')
      .toArray()
      .map((r) => r.room_id);
    this.ctx.storage.sql.exec('DELETE FROM helper_status');
    // The account's app tokens stop working with it; its room sockets are kicked by user id.
    this.ctx.storage.sql.exec('DELETE FROM app_targets');
    return [...new Set(rooms)];
  }

  // --- Handshake and presence ---

  private onHello(
    ws: WebSocket,
    me: HubAttachment,
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
    // A device token connects only as that device's helper, and only it may (PROTOCOL.md 4).
    if (
      (me.deviceId !== undefined || hello.client === 'helper') &&
      (hello.client !== 'helper' || hello.deviceId !== me.deviceId)
    ) {
      sendError(ws, { code: ErrorCode.Unauthenticated }, id);
      this.disconnect(ws, CloseCode.Unauthenticated);
      return;
    }
    const updated: HubAttachment = {
      ...me,
      hello: {
        client: hello.client,
        clientVersion: hello.clientVersion,
        protocol: hello.protocol,
        ...(hello.tabId ? { tabId: hello.tabId } : {}),
      },
    };
    ws.serializeAttachment(updated);

    // A newer connection of the same client replaces the older one (close 4002).
    const key = hello.client === 'helper' ? me.deviceId : hello.tabId;
    if (key) {
      for (const { ws: other, a } of this.present()) {
        if (other === ws || a.hello?.client !== hello.client) continue;
        if ((hello.client === 'helper' ? a.deviceId : a.hello.tabId) === key) {
          this.disconnect(other, CloseCode.Replaced);
        }
      }
    }

    send(
      ws,
      'hub.welcome',
      {
        protocol: PROTOCOL_VERSION,
        minProtocol: MIN_PROTOCOL,
        serverTime: Date.now(),
        userId: me.userId,
        connectionId: me.connectionId,
        helpers: this.onlineHelpers(),
      },
      id,
    );
    if (hello.client === 'helper') {
      const info = helperInfo(updated);
      if (info) this.broadcastToTabs('helper.online', { helper: info });
    } else {
      // The tab learns each helper's current state; helpers send status only on changes.
      for (const row of this.ctx.storage.sql
        .exec<{ payload: string }>('SELECT payload FROM helper_status ORDER BY device_id')
        .toArray()) {
        sendFrame(ws, encodeMessage('helper.status', JSON.parse(row.payload)));
      }
    }
  }

  /**
   * Closes a socket from the server side and cleans up after it at once; also the handler for a
   * client-side close. Idempotent: the runtime may report a close after we started one.
   */
  private disconnect(ws: WebSocket, code: CloseCode | typeof BREAKER_CLOSE_CODE): void {
    const me = attachmentOf(ws);
    if (me.closing) return;
    ws.serializeAttachment({ ...me, closing: true } satisfies HubAttachment);
    try {
      ws.close(code, CLOSE_REASONS[code]);
    } catch {
      // Already closed.
    }
    if (!me.hello) return;
    const sql = this.ctx.storage.sql;
    if (me.hello.client === 'web') {
      sql.exec('DELETE FROM pending WHERE tab_conn = ?', me.connectionId);
      sql.exec('DELETE FROM thumbnail_targets WHERE tab_conn = ?', me.connectionId);
      return;
    }
    const deviceId = me.deviceId;
    if (!deviceId) return;
    // Commands this socket never answered fail now (PROTOCOL.md 8.2).
    const orphans = sql
      .exec<PendingRow>('DELETE FROM pending WHERE helper_conn = ? RETURNING *', me.connectionId)
      .toArray();
    for (const row of orphans) {
      this.replyToTab(row, 'error', { code: ErrorCode.HelperOffline, deviceId });
    }
    // Replaced by a newer socket of the same device: still online.
    if (this.helperSockets(deviceId).length) return;
    sql.exec('DELETE FROM helper_status WHERE device_id = ?', deviceId);
    sql.exec('DELETE FROM thumbnail_targets WHERE device_id = ?', deviceId);
    this.flushHelperWindows((w) => w.deviceId === deviceId, true);
    this.broadcastToTabs('helper.offline', { deviceId });
  }

  // --- Metrics ---

  /** Adds one helper.stats to its stream's window, and writes the window once it is full. */
  private recordHelperStats(deviceId: string, payload: PayloadOf<'helper.stats'>): void {
    const now = Date.now();
    const key = `${deviceId}/${payload.streamId}`;
    let entry = this.helperWindows.get(key);
    if (!entry) {
      // The room comes from the helper's own last helper.status for this stream.
      const row = this.ctx.storage.sql
        .exec<{ payload: string }>(
          'SELECT payload FROM helper_status WHERE device_id = ?',
          deviceId,
        )
        .toArray()[0];
      const status = row ? (JSON.parse(row.payload) as PayloadOf<'helper.status'>) : null;
      const roomId = status?.stream?.streamId === payload.streamId ? status.stream.roomId : null;
      if (!roomId) return;
      entry = { deviceId, roomId, window: emptyHelperWindow(now) };
      this.helperWindows.set(key, entry);
    }
    addHelperSample(entry.window, payload);
    if (now - entry.window.startedAt >= HELPER_WINDOW_MS) {
      this.flushHelperWindows((w) => w === entry);
    }
  }

  /** Writes the matching windows; `remove` also forgets them (the stream or helper is gone). */
  private flushHelperWindows(
    match: (w: { deviceId: string; roomId: string; window: HelperWindow }, key: string) => boolean,
    remove = false,
  ): void {
    const now = Date.now();
    for (const [key, entry] of this.helperWindows) {
      if (!match(entry, key)) continue;
      if (remove) this.helperWindows.delete(key);
      // The stream id is the part after the device id.
      const streamId = key.slice(entry.deviceId.length + 1);
      const window = entry.window;
      if (window.samples === 0) continue;
      entry.window = emptyHelperWindow(now);
      void this.spaceOf(entry.roomId).then((spaceId) =>
        writeHelper(
          metricsDataset(this.env),
          { spaceId, roomId: entry.roomId, streamId },
          window,
          now,
        ),
      );
    }
  }

  private async spaceOf(roomId: string): Promise<string | null> {
    const known = this.roomSpaces.get(roomId);
    if (known !== undefined) return known;
    const row = await this.env.DB.prepare('SELECT space_id FROM rooms WHERE id = ?')
      .bind(roomId)
      .first<{ space_id: string }>()
      .catch(() => null);
    const spaceId = row?.space_id ?? null;
    this.roomSpaces.set(roomId, spaceId);
    return spaceId;
  }

  // --- Relay ---

  /** A web tab's command: forwarded to the helper with a hub-chosen id (PROTOCOL.md 8.2). */
  private onCommand(ws: WebSocket, me: HubAttachment, msg: Command): void {
    const { deviceId } = msg.payload;
    const helper = this.helperSockets(deviceId)[0];
    if (!helper) {
      sendError(ws, { code: ErrorCode.HelperOffline, deviceId }, msg.id);
      return;
    }
    const now = Date.now();
    const hubId = newId('h');
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM pending WHERE created_at <= ?', now - PENDING_TTL_MS);
    sql.exec(
      `INSERT INTO pending (hub_id, device_id, helper_conn, tab_conn, tab_msg_id, thumbnails, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      hubId,
      deviceId,
      attachmentOf(helper).connectionId,
      me.connectionId,
      msg.id ?? null,
      msg.type === 'helper.listSources' && msg.payload.thumbnails ? 1 : 0,
      now,
    );
    sendFrame(helper, JSON.stringify({ type: msg.type, id: hubId, payload: msg.payload }));
  }

  /**
   * A message from a helper: a reply to a relayed command, or a report for the tabs. The hub
   * writes the helper's own deviceId into every payload, so a helper cannot speak for another.
   * Returns false when the message is not one the hub takes from a helper.
   */
  private onHelperMessage(ws: WebSocket, deviceId: string, msg: Message): boolean {
    const sql = this.ctx.storage.sql;
    if (msg.id && (msg.type === 'ack' || msg.type === 'error' || msg.type === 'helper.sources')) {
      const row = sql
        .exec<PendingRow>(
          'DELETE FROM pending WHERE hub_id = ? AND helper_conn = ? RETURNING *',
          msg.id,
          attachmentOf(ws).connectionId,
        )
        .toArray()[0];
      if (!row) return true; // late (the tab left, or the command expired): dropped
      if (msg.type === 'helper.sources') {
        if (row.thumbnails) {
          sql.exec(
            `INSERT INTO thumbnail_targets (device_id, tab_conn, expires_at) VALUES (?, ?, ?)
             ON CONFLICT (device_id) DO UPDATE SET tab_conn = excluded.tab_conn,
               expires_at = excluded.expires_at`,
            deviceId,
            row.tab_conn,
            Date.now() + THUMBNAIL_WINDOW_MS,
          );
        }
        this.replyToTab(row, 'helper.sources', { ...msg.payload, deviceId });
      } else if (msg.type === 'error') {
        this.replyToTab(row, 'error', msg.payload);
      } else {
        this.replyToTab(row, 'ack', {});
      }
      return true;
    }
    switch (msg.type) {
      case 'helper.status': {
        const payload = { ...msg.payload, deviceId };
        sql.exec(
          `INSERT INTO helper_status (device_id, payload) VALUES (?, ?)
           ON CONFLICT (device_id) DO UPDATE SET payload = excluded.payload
           WHERE payload <> excluded.payload`,
          deviceId,
          JSON.stringify(payload),
        );
        this.broadcastToTabs('helper.status', payload);
        // A stream that is no longer the helper's current one ended: its last window goes out.
        const current = `${deviceId}/${payload.stream?.streamId ?? ''}`;
        this.flushHelperWindows((w, key) => w.deviceId === deviceId && key !== current, true);
        return true;
      }
      case 'helper.stats':
        this.broadcastToTabs('helper.stats', { ...msg.payload, deviceId });
        this.recordHelperStats(deviceId, msg.payload);
        return true;
      case 'helper.voiceShortcut':
        // A global voice shortcut (8.5): to every tab, which decides who acts. Nothing is stored.
        this.broadcastToTabs('helper.voiceShortcut', { ...msg.payload, deviceId });
        return true;
      case 'helper.sourceThumbnail': {
        // Only to the tab that listed the sources; nothing of it is stored.
        const target = sql
          .exec<{ tab_conn: string }>(
            'SELECT tab_conn FROM thumbnail_targets WHERE device_id = ? AND expires_at > ?',
            deviceId,
            Date.now(),
          )
          .toArray()[0];
        if (target) {
          this.sendToConnection(target.tab_conn, 'helper.sourceThumbnail', {
            ...msg.payload,
            deviceId,
          });
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Sends a helper's reply to the tab that asked, under the tab's own id. */
  private replyToTab<T extends 'ack' | 'error' | 'helper.sources'>(
    row: PendingRow,
    type: T,
    payload: PayloadOf<T>,
  ): void {
    // A request without id gets no reply on success; errors still go out (PROTOCOL.md 3).
    if (row.tab_msg_id === null && type === 'ack') return;
    this.sendToConnection(row.tab_conn, type, payload, row.tab_msg_id ?? undefined);
  }

  // --- Sockets ---

  private present(): { ws: WebSocket; a: HubAttachment }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, a: attachmentOf(ws) }))
      .filter(({ ws, a }) => a.hello && !a.closing && ws.readyState === WebSocket.OPEN);
  }

  private helperSockets(deviceId: string): WebSocket[] {
    return this.present()
      .filter(({ a }) => a.hello?.client === 'helper' && a.deviceId === deviceId)
      .map(({ ws }) => ws);
  }

  private onlineHelpers(): HelperInfo[] {
    const byDevice = new Map<string, HelperInfo>();
    for (const { a } of this.present()) {
      const info = helperInfo(a);
      if (info) byDevice.set(info.deviceId, info);
    }
    return [...byDevice.values()];
  }

  private sendToConnection<T extends MessageType>(
    connectionId: string,
    type: T,
    payload: PayloadOf<T>,
    id?: MessageId,
  ): void {
    for (const ws of this.ctx.getWebSockets(connTag(connectionId))) {
      if (!attachmentOf(ws).closing) send(ws, type, payload, id);
    }
  }

  private broadcastToTabs<T extends MessageType>(type: T, payload: PayloadOf<T>): void {
    const frame = encodeMessage(type, payload);
    for (const { ws, a } of this.present()) {
      if (a.hello?.client === 'web') sendFrame(ws, frame);
    }
  }
}

/** A helper connection as hub.welcome and helper.online show it; null for web tabs. */
function helperInfo(a: HubAttachment): HelperInfo | null {
  if (a.hello?.client !== 'helper' || !a.deviceId || !a.device) return null;
  return {
    deviceId: a.deviceId,
    name: a.device.name,
    os: a.device.os,
    arch: a.device.arch,
    // The version it runs now; the one recorded at pairing may be older.
    helperVersion: a.hello.clientVersion,
    protocol: a.hello.protocol,
  };
}

function attachmentOf(ws: WebSocket): HubAttachment {
  return ws.deserializeAttachment() as HubAttachment;
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
    // The socket closed meanwhile; its close handler cleans up.
  }
}

// Every RPC method counts as a request and is refused while the breaker is open (do/breaker.ts).
guardRpc(UserHubDO, [
  'deviceJoinedRoom',
  'takeDeviceRooms',
  'appJoined',
  'revokeApp',
  'notice',
  'revokeDevice',
  'revokeAll',
]);
