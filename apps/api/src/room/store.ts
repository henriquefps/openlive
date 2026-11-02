// SPDX-License-Identifier: AGPL-3.0-only
import type { Role, RoomInfo, RoomSettings, Track, VideoCodec } from '@openlive/protocol';
import type { RoomStream } from './types';

// The RoomDO's durable state, in the DO's SQLite. Everything a hibernated room must remember
// lives here (streams, slots, the queue, the room snapshot), so a wake-up needs no rebuild:
// connection identity lives in the WebSocket attachments, the rest is read from these tables.
//
// Rows written are the scarce resource (Workers Free: 100,000 a day for the whole instance, index
// rows included), so nothing here is written when it did not change, and the two
// things that change all the time stay in memory between writes: a slot's lease (below) and the
// usage meter's running totals (room/meter.ts).

/**
 * Viewer slot lease; clients renew every LEASE_MS / 3. 90 s (was 30 s): every renewal is a Durable Object request (100,000 a day on Workers Free), and a
 * hidden browser tab may run its timers only once a minute. A closed socket still frees its slots
 * at once; the lease only bounds a socket that died without a close.
 */
export const LEASE_MS = 90_000;
/**
 * A renewed lease is written to SQLite at most this often; in between it lives in
 * memory. After the object is evicted, a slot whose stored expiry is less than this old may have
 * been renewed meanwhile, so it gets a fresh LEASE_MS from the wake-up; an older one is not.
 */
export const LEASE_PERSIST_MS = 5 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS streams (
  stream_id    TEXT PRIMARY KEY,
  viewer_limit INTEGER NOT NULL,
  info_json    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
  slot_id       TEXT PRIMARY KEY,
  stream_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_stream_idx ON slots (stream_id);
CREATE INDEX IF NOT EXISTS slots_connection_idx ON slots (connection_id);
CREATE TABLE IF NOT EXISTS queue (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  connection_id    TEXT NOT NULL,
  -- 0 = owner, admin or member; 1 = guest. Members go first.
  priority         INTEGER NOT NULL,
  offer_id         TEXT UNIQUE,
  offer_expires_at INTEGER,
  UNIQUE (stream_id, connection_id)
);
-- A helper's SFU session from POST .../publish until it ends. announce_by is set until
-- stream.announce turns it into a stream (stream_id).
CREATE TABLE IF NOT EXISTS publications (
  sfu_session_id   TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  tracks_json      TEXT NOT NULL,
  max_bitrate_kbps INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  announce_by      INTEGER,
  stream_id        TEXT UNIQUE
);
-- What the room knows about a live stream beyond its StreamInfo; never sent to clients.
CREATE TABLE IF NOT EXISTS stream_sfu (
  stream_id      TEXT PRIMARY KEY,
  sfu_session_id TEXT NOT NULL,
  streamer_role  TEXT NOT NULL,
  tracks_json    TEXT NOT NULL,
  -- Set while the helper's socket is gone (15 s grace).
  grace_until    INTEGER
);
-- One SFU session per viewer per room, with no media until a subscribe.
CREATE TABLE IF NOT EXISTS viewer_sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS viewer_sessions_user_idx ON viewer_sessions (user_id, created_at);
-- A stream pulled onto a viewer session under a slot. Dropped (and its tracks closed) as soon as
-- the slot goes.
CREATE TABLE IF NOT EXISTS subscriptions (
  session_id TEXT NOT NULL,
  stream_id  TEXT NOT NULL,
  slot_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  mids_json  TEXT NOT NULL,
  rid        TEXT,
  PRIMARY KEY (session_id, stream_id)
);
-- The voice channel (docs/PROTOCOL.md 7.5): one row per user in voice, bound to the tab
-- (connection) they joined from. Voice does not use slots.
CREATE TABLE IF NOT EXISTS voice_participants (
  user_id       TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  muted         INTEGER NOT NULL,
  deafened      INTEGER NOT NULL,
  server_muted  INTEGER NOT NULL,
  joined_at     INTEGER NOT NULL
);
-- A participant's microphone, a local track on their viewer session. track_id is what clients see.
CREATE TABLE IF NOT EXISTS voice_tracks (
  track_id   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  mid        TEXT NOT NULL
);
-- A microphone pulled onto a listener's viewer session.
CREATE TABLE IF NOT EXISTS voice_pulls (
  session_id TEXT NOT NULL,
  track_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  mid        TEXT NOT NULL,
  PRIMARY KEY (session_id, track_id)
);
-- A participant's camera (docs/PROTOCOL.md 7.7), a simulcast local video on their viewer session.
CREATE TABLE IF NOT EXISTS camera_tracks (
  track_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE,
  session_id   TEXT NOT NULL,
  track_name   TEXT NOT NULL,
  mid          TEXT NOT NULL,
  -- Simulcast layers, highest first; [] when the camera is not simulcast.
  rids_json    TEXT NOT NULL,
  published_at INTEGER NOT NULL
);
-- A camera pulled onto a viewer's session, on one layer (rid null: not simulcast).
CREATE TABLE IF NOT EXISTS camera_pulls (
  session_id TEXT NOT NULL,
  track_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  mid        TEXT NOT NULL,
  rid        TEXT,
  PRIMARY KEY (session_id, track_id)
);
-- The usage meter's running totals since the last flush to D1.
CREATE TABLE IF NOT EXISTS meter (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_at       INTEGER NOT NULL,
  viewer_mbit_s REAL NOT NULL DEFAULT 0,
  join_mbps     REAL NOT NULL DEFAULT 0,
  viewer_s      REAL NOT NULL DEFAULT 0,
  stream_s      REAL NOT NULL DEFAULT 0
);
`;

/** A published track with its mid in the helper's session. */
export interface PublishedTrackRow extends Track {
  mid: string;
}

export interface PublicationRow {
  sfu_session_id: string;
  user_id: string;
  device_id: string;
  tracks: PublishedTrackRow[];
  max_bitrate_kbps: number;
  created_at: number;
  announce_by: number | null;
  stream_id: string | null;
}

export interface StreamSfuRow {
  stream_id: string;
  sfu_session_id: string;
  streamer_role: Role;
  tracks: PublishedTrackRow[];
  grace_until: number | null;
}

export interface SubscriptionRow {
  session_id: string;
  stream_id: string;
  slot_id: string;
  user_id: string;
  /** The pulled tracks; the video one says its codec (absent: h264; since 1.14). */
  mids: { mid: string; kind: 'video' | 'audio'; codec?: VideoCodec }[];
  rid: string | null;
}

export interface VoiceParticipantRow {
  user_id: string;
  connection_id: string;
  muted: boolean;
  deafened: boolean;
  server_muted: boolean;
  joined_at: number;
}

export interface VoiceTrackRow {
  track_id: string;
  user_id: string;
  session_id: string;
  track_name: string;
  mid: string;
}

export interface VoicePullRow {
  session_id: string;
  track_id: string;
  /** The listener. */
  user_id: string;
  mid: string;
}

export interface CameraTrackRow {
  track_id: string;
  user_id: string;
  session_id: string;
  track_name: string;
  mid: string;
  /** Simulcast layers, highest first. */
  rids: string[];
  published_at: number;
}

export interface CameraPullRow {
  session_id: string;
  track_id: string;
  /** The viewer. */
  user_id: string;
  mid: string;
  rid: string | null;
}

export interface MeterRow {
  last_at: number;
  viewer_mbit_s: number;
  join_mbps: number;
  viewer_s: number;
  stream_s: number;
}

export interface SlotRow {
  slot_id: string;
  stream_id: string;
  user_id: string;
  connection_id: string;
  expires_at: number;
}

export interface QueueRow {
  seq: number;
  stream_id: string;
  user_id: string;
  connection_id: string;
  priority: number;
  offer_id: string | null;
  offer_expires_at: number | null;
}

export const queuePriority = (role: Role): number => (role === 'guest' ? 1 : 0);

type Row = Record<string, SqlStorageValue>;

export class RoomStore {
  /** The meter's running totals, ahead of the stored row between saveMeter calls. */
  private meterRow: MeterRow | null = null;
  private meterDirty = false;
  /** Lease expiry by slot id; null until first used (built from the slots table). */
  private leases: Map<string, number> | null = null;
  /** expires_at as last written, by slot id. */
  private readonly storedLeases = new Map<string, number>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec(SCHEMA);
  }

  private all<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec<Row>(query, ...bindings).toArray() as T[];
  }

  private first<T>(query: string, ...bindings: SqlStorageValue[]): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }

  // --- Room snapshot (refreshed by the Worker on every connection) ---

  private getMeta<T>(key: string): T | null {
    const row = this.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  /** Writes nothing when the value is the same (the room snapshot is set on every connect). */
  private setMeta(key: string, value: unknown): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
      key,
      JSON.stringify(value),
    );
  }

  room(): RoomInfo | null {
    return this.getMeta<RoomInfo>('room');
  }

  setRoom(room: RoomInfo): void {
    this.setMeta('room', room);
  }

  settings(): RoomSettings | null {
    return this.getMeta<RoomSettings>('settings');
  }

  setSettings(settings: RoomSettings): void {
    this.setMeta('settings', settings);
  }

  // --- Streams ---

  upsertStream(stream: RoomStream): void {
    this.sql.exec(
      `INSERT INTO streams (stream_id, viewer_limit, info_json) VALUES (?, ?, ?)
       ON CONFLICT (stream_id) DO UPDATE SET viewer_limit = excluded.viewer_limit, info_json = excluded.info_json`,
      stream.streamId,
      stream.viewerLimit,
      JSON.stringify(stream),
    );
  }

  stream(streamId: string): RoomStream | null {
    const row = this.first<{ info_json: string }>(
      'SELECT info_json FROM streams WHERE stream_id = ?',
      streamId,
    );
    return row ? (JSON.parse(row.info_json) as RoomStream) : null;
  }

  deleteStream(streamId: string): void {
    this.sql.exec('DELETE FROM streams WHERE stream_id = ?', streamId);
    this.sql.exec('DELETE FROM stream_sfu WHERE stream_id = ?', streamId);
    this.forgetLeases(
      this.all<{ slot_id: string }>(
        'DELETE FROM slots WHERE stream_id = ? RETURNING slot_id',
        streamId,
      ).map((r) => r.slot_id),
    );
    this.sql.exec('DELETE FROM queue WHERE stream_id = ?', streamId);
  }

  streams(): RoomStream[] {
    return this.all<{ info_json: string }>('SELECT info_json FROM streams ORDER BY stream_id').map(
      (r) => JSON.parse(r.info_json) as RoomStream,
    );
  }

  // --- Slots ---

  insertSlot(slot: SlotRow): void {
    this.sql.exec(
      'INSERT INTO slots (slot_id, stream_id, user_id, connection_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      slot.slot_id,
      slot.stream_id,
      slot.user_id,
      slot.connection_id,
      slot.expires_at,
    );
    this.leaseMap().set(slot.slot_id, slot.expires_at);
    this.storedLeases.set(slot.slot_id, slot.expires_at);
  }

  slot(slotId: string): SlotRow | null {
    return this.withLease(this.first<SlotRow>('SELECT * FROM slots WHERE slot_id = ?', slotId));
  }

  slotOf(connectionId: string, streamId: string): SlotRow | null {
    return this.withLease(
      this.first<SlotRow>(
        'SELECT * FROM slots WHERE connection_id = ? AND stream_id = ?',
        connectionId,
        streamId,
      ),
    );
  }

  /**
   * Moves a lease's expiry. Kept in memory; written only when the stored expiry is
   * LEASE_PERSIST_MS behind, so a viewer renewing every 10 s costs one row per 5 minutes.
   */
  renewSlot(slotId: string, expiresAt: number): void {
    this.leaseMap().set(slotId, expiresAt);
    if (expiresAt - (this.storedLeases.get(slotId) ?? 0) < LEASE_PERSIST_MS) return;
    this.sql.exec('UPDATE slots SET expires_at = ? WHERE slot_id = ?', expiresAt, slotId);
    this.storedLeases.set(slotId, expiresAt);
  }

  deleteSlot(slotId: string): void {
    this.sql.exec('DELETE FROM slots WHERE slot_id = ?', slotId);
    this.forgetLeases([slotId]);
  }

  slotsOf(streamId: string): SlotRow[] {
    return this.all<SlotRow>(
      'SELECT * FROM slots WHERE stream_id = ? ORDER BY slot_id',
      streamId,
    ).map((s) => this.withLease(s));
  }

  /** The earliest lease expiry, from memory. */
  nextLeaseExpiry(): number | null {
    let next: number | null = null;
    for (const t of this.leaseMap().values()) if (next === null || t < next) next = t;
    return next;
  }

  /**
   * The leases, built from the slots table the first time after a wake-up. A stored expiry
   * younger than LEASE_PERSIST_MS may hide renewals made in memory before the eviction, so it is
   * extended to a full lease from now: nothing a live viewer holds is lost. An older one is kept,
   * so a viewer that is gone still loses the slot (at the latest LEASE_PERSIST_MS + 2 leases after
   * its last renewal) instead of every wake-up extending it again.
   */
  private leaseMap(): Map<string, number> {
    if (this.leases) return this.leases;
    const now = Date.now();
    const leases = new Map<string, number>();
    for (const r of this.all<{ slot_id: string; expires_at: number }>(
      'SELECT slot_id, expires_at FROM slots',
    )) {
      this.storedLeases.set(r.slot_id, r.expires_at);
      const maybeRenewed = r.expires_at > now - LEASE_PERSIST_MS;
      leases.set(r.slot_id, maybeRenewed ? Math.max(r.expires_at, now + LEASE_MS) : r.expires_at);
    }
    this.leases = leases;
    return leases;
  }

  private withLease<T extends SlotRow | null>(slot: T): T {
    if (!slot) return slot;
    return { ...slot, expires_at: this.leaseMap().get(slot.slot_id) ?? slot.expires_at };
  }

  private forgetLeases(slotIds: string[]): void {
    for (const id of slotIds) {
      this.leases?.delete(id);
      this.storedLeases.delete(id);
    }
  }

  /** Slots held plus offers outstanding: an offer reserves its slot for 30 s. */
  reserved(streamId: string): number {
    const row = this.first<{ n: number }>(
      `SELECT (SELECT count(*) FROM slots WHERE stream_id = ?1)
            + (SELECT count(*) FROM queue WHERE stream_id = ?1 AND offer_id IS NOT NULL) AS n`,
      streamId,
    );
    return row?.n ?? 0;
  }

  // --- Queue ---

  /** The stream's queue in serving order: members before guests, then first come first served. */
  queue(streamId: string): QueueRow[] {
    return this.all<QueueRow>(
      'SELECT * FROM queue WHERE stream_id = ? ORDER BY priority, seq',
      streamId,
    );
  }

  /** connectionId → 1-based position in the stream's queue. */
  positions(streamId: string): Map<string, number> {
    return new Map(this.queue(streamId).map((q, i) => [q.connection_id, i + 1]));
  }

  queueEntry(connectionId: string, streamId: string): QueueRow | null {
    return this.first<QueueRow>(
      'SELECT * FROM queue WHERE connection_id = ? AND stream_id = ?',
      connectionId,
      streamId,
    );
  }

  enqueue(entry: Pick<QueueRow, 'stream_id' | 'user_id' | 'connection_id' | 'priority'>): void {
    this.sql.exec(
      'INSERT INTO queue (stream_id, user_id, connection_id, priority) VALUES (?, ?, ?, ?)',
      entry.stream_id,
      entry.user_id,
      entry.connection_id,
      entry.priority,
    );
  }

  dequeue(seq: number): void {
    this.sql.exec('DELETE FROM queue WHERE seq = ?', seq);
  }

  offer(offerId: string): QueueRow | null {
    return this.first<QueueRow>('SELECT * FROM queue WHERE offer_id = ?', offerId);
  }

  setOffer(seq: number, offerId: string, expiresAt: number): void {
    this.sql.exec(
      'UPDATE queue SET offer_id = ?, offer_expires_at = ? WHERE seq = ?',
      offerId,
      expiresAt,
      seq,
    );
  }

  setUserPriority(userId: string, priority: number): string[] {
    return this.all<{ stream_id: string }>(
      'UPDATE queue SET priority = ? WHERE user_id = ? RETURNING stream_id',
      priority,
      userId,
    ).map((r) => r.stream_id);
  }

  // --- Publications and stream internals ---

  insertPublication(p: PublicationRow): void {
    this.sql.exec(
      `INSERT INTO publications
         (sfu_session_id, user_id, device_id, tracks_json, max_bitrate_kbps, created_at, announce_by, stream_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      p.sfu_session_id,
      p.user_id,
      p.device_id,
      JSON.stringify(p.tracks),
      p.max_bitrate_kbps,
      p.created_at,
      p.announce_by,
      p.stream_id,
    );
  }

  private publicationOf(row: Row | null): PublicationRow | null {
    if (!row) return null;
    const { tracks_json, ...rest } = row as unknown as Omit<PublicationRow, 'tracks'> & {
      tracks_json: string;
    };
    return { ...rest, tracks: JSON.parse(tracks_json) as PublishedTrackRow[] };
  }

  publication(sfuSessionId: string): PublicationRow | null {
    return this.publicationOf(
      this.first<Row>('SELECT * FROM publications WHERE sfu_session_id = ?', sfuSessionId),
    );
  }

  publicationOfStream(streamId: string): PublicationRow | null {
    return this.publicationOf(
      this.first<Row>('SELECT * FROM publications WHERE stream_id = ?', streamId),
    );
  }

  /** Publications not announced yet whose deadline passed. */
  expiredPublications(now: number): PublicationRow[] {
    return this.all<Row>(
      'SELECT * FROM publications WHERE stream_id IS NULL AND announce_by <= ?',
      now,
    ).map((r) => this.publicationOf(r) as PublicationRow);
  }

  /** Publications that are not streams yet, still within their deadline. */
  pendingPublications(now: number): number {
    return (
      this.first<{ n: number }>(
        'SELECT count(*) AS n FROM publications WHERE stream_id IS NULL AND announce_by > ?',
        now,
      )?.n ?? 0
    );
  }

  announcePublication(sfuSessionId: string, streamId: string): void {
    this.sql.exec(
      'UPDATE publications SET stream_id = ?, announce_by = NULL WHERE sfu_session_id = ?',
      streamId,
      sfuSessionId,
    );
  }

  deletePublication(sfuSessionId: string): void {
    this.sql.exec('DELETE FROM publications WHERE sfu_session_id = ?', sfuSessionId);
  }

  insertStreamSfu(row: StreamSfuRow): void {
    this.sql.exec(
      `INSERT INTO stream_sfu (stream_id, sfu_session_id, streamer_role, tracks_json, grace_until)
       VALUES (?, ?, ?, ?, ?)`,
      row.stream_id,
      row.sfu_session_id,
      row.streamer_role,
      JSON.stringify(row.tracks),
      row.grace_until,
    );
  }

  streamSfu(streamId: string): StreamSfuRow | null {
    const row = this.first<Omit<StreamSfuRow, 'tracks'> & { tracks_json: string }>(
      'SELECT * FROM stream_sfu WHERE stream_id = ?',
      streamId,
    );
    if (!row) return null;
    const { tracks_json, ...rest } = row;
    return { ...rest, tracks: JSON.parse(tracks_json) as PublishedTrackRow[] };
  }

  /** Starts or stops the helper-disconnected grace of the given streams. */
  setGrace(streamIds: string[], graceUntil: number | null): void {
    for (const id of streamIds) {
      this.sql.exec('UPDATE stream_sfu SET grace_until = ? WHERE stream_id = ?', graceUntil, id);
    }
  }

  graceExpired(now: number): string[] {
    return this.all<{ stream_id: string }>(
      'SELECT stream_id FROM stream_sfu WHERE grace_until IS NOT NULL AND grace_until <= ?',
      now,
    ).map((r) => r.stream_id);
  }

  // --- Viewer sessions and subscriptions ---

  insertViewerSession(sessionId: string, userId: string, now: number): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO viewer_sessions (session_id, user_id, created_at) VALUES (?, ?, ?)',
      sessionId,
      userId,
      now,
    );
  }

  viewerSession(sessionId: string): { session_id: string; user_id: string } | null {
    return this.first('SELECT * FROM viewer_sessions WHERE session_id = ?', sessionId);
  }

  /** The user's viewer sessions, oldest first. */
  viewerSessionsOf(userId: string): string[] {
    return this.all<{ session_id: string }>(
      'SELECT session_id FROM viewer_sessions WHERE user_id = ? ORDER BY created_at, session_id',
      userId,
    ).map((r) => r.session_id);
  }

  deleteViewerSession(sessionId: string): void {
    this.sql.exec('DELETE FROM viewer_sessions WHERE session_id = ?', sessionId);
  }

  private subscriptionOf(row: Row): SubscriptionRow {
    const { mids_json, ...rest } = row as unknown as Omit<SubscriptionRow, 'mids'> & {
      mids_json: string;
    };
    return { ...rest, mids: JSON.parse(mids_json) as SubscriptionRow['mids'] };
  }

  upsertSubscription(sub: SubscriptionRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (session_id, stream_id, slot_id, user_id, mids_json, rid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sub.session_id,
      sub.stream_id,
      sub.slot_id,
      sub.user_id,
      JSON.stringify(sub.mids),
      sub.rid,
    );
  }

  subscription(sessionId: string, streamId: string): SubscriptionRow | null {
    const row = this.first<Row>(
      'SELECT * FROM subscriptions WHERE session_id = ? AND stream_id = ?',
      sessionId,
      streamId,
    );
    return row ? this.subscriptionOf(row) : null;
  }

  subscriptionsOfSession(sessionId: string): SubscriptionRow[] {
    return this.all<Row>('SELECT * FROM subscriptions WHERE session_id = ?', sessionId).map((r) =>
      this.subscriptionOf(r),
    );
  }

  setSubscriptionRid(sessionId: string, streamId: string, rid: string): void {
    this.sql.exec(
      'UPDATE subscriptions SET rid = ? WHERE session_id = ? AND stream_id = ?',
      rid,
      sessionId,
      streamId,
    );
  }

  deleteSubscription(sessionId: string, streamId: string): void {
    this.sql.exec(
      'DELETE FROM subscriptions WHERE session_id = ? AND stream_id = ?',
      sessionId,
      streamId,
    );
  }

  /** Removes and returns the subscriptions whose slot is gone (released, expired, stream ended). */
  takeOrphanSubscriptions(): SubscriptionRow[] {
    return this.all<Row>(
      'DELETE FROM subscriptions WHERE slot_id NOT IN (SELECT slot_id FROM slots) RETURNING *',
    ).map((r) => this.subscriptionOf(r));
  }

  // --- Voice channel (docs/PROTOCOL.md 7.5) ---

  private participantOf(row: Row): VoiceParticipantRow {
    return {
      user_id: row['user_id'] as string,
      connection_id: row['connection_id'] as string,
      muted: row['muted'] === 1,
      deafened: row['deafened'] === 1,
      server_muted: row['server_muted'] === 1,
      joined_at: row['joined_at'] as number,
    };
  }

  /** An upsert, not a REPLACE (a delete plus an insert); a mute toggle writes one row. */
  upsertVoiceParticipant(p: VoiceParticipantRow): void {
    this.sql.exec(
      `INSERT INTO voice_participants
         (user_id, connection_id, muted, deafened, server_muted, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET connection_id = excluded.connection_id,
         muted = excluded.muted, deafened = excluded.deafened,
         server_muted = excluded.server_muted, joined_at = excluded.joined_at
       WHERE connection_id <> excluded.connection_id OR muted <> excluded.muted
         OR deafened <> excluded.deafened OR server_muted <> excluded.server_muted
         OR joined_at <> excluded.joined_at`,
      p.user_id,
      p.connection_id,
      p.muted ? 1 : 0,
      p.deafened ? 1 : 0,
      p.server_muted ? 1 : 0,
      p.joined_at,
    );
  }

  voiceParticipant(userId: string): VoiceParticipantRow | null {
    const row = this.first<Row>('SELECT * FROM voice_participants WHERE user_id = ?', userId);
    return row ? this.participantOf(row) : null;
  }

  /** Everyone in voice, in the order they joined. */
  voiceParticipants(): VoiceParticipantRow[] {
    return this.all<Row>('SELECT * FROM voice_participants ORDER BY joined_at, user_id').map((r) =>
      this.participantOf(r),
    );
  }

  deleteVoiceParticipant(userId: string): void {
    this.sql.exec('DELETE FROM voice_participants WHERE user_id = ?', userId);
  }

  /** Users under a server mute: it lasts until lifted, also across leaving and joining again. */
  serverMuted(userId: string): boolean {
    return (this.getMeta<string[]>('voice_server_muted') ?? []).includes(userId);
  }

  setServerMuted(userId: string, muted: boolean): void {
    const others = (this.getMeta<string[]>('voice_server_muted') ?? []).filter((u) => u !== userId);
    this.setMeta('voice_server_muted', muted ? [...others, userId] : others);
  }

  insertVoiceTrack(t: VoiceTrackRow): void {
    this.sql.exec(
      `INSERT INTO voice_tracks (track_id, user_id, session_id, track_name, mid)
       VALUES (?, ?, ?, ?, ?)`,
      t.track_id,
      t.user_id,
      t.session_id,
      t.track_name,
      t.mid,
    );
  }

  voiceTrack(trackId: string): VoiceTrackRow | null {
    return this.first('SELECT * FROM voice_tracks WHERE track_id = ?', trackId);
  }

  voiceTrackOf(userId: string): VoiceTrackRow | null {
    return this.first('SELECT * FROM voice_tracks WHERE user_id = ?', userId);
  }

  voiceTracks(): VoiceTrackRow[] {
    return this.all('SELECT * FROM voice_tracks ORDER BY track_id');
  }

  deleteVoiceTrack(trackId: string): void {
    this.sql.exec('DELETE FROM voice_tracks WHERE track_id = ?', trackId);
  }

  upsertVoicePull(p: VoicePullRow): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO voice_pulls (session_id, track_id, user_id, mid) VALUES (?, ?, ?, ?)',
      p.session_id,
      p.track_id,
      p.user_id,
      p.mid,
    );
  }

  voicePull(sessionId: string, trackId: string): VoicePullRow | null {
    return this.first(
      'SELECT * FROM voice_pulls WHERE session_id = ? AND track_id = ?',
      sessionId,
      trackId,
    );
  }

  deleteVoicePull(sessionId: string, trackId: string): void {
    this.sql.exec(
      'DELETE FROM voice_pulls WHERE session_id = ? AND track_id = ?',
      sessionId,
      trackId,
    );
  }

  /** Removes and returns the pulls of a track, of a listener, of a session, or all of them. */
  takeVoicePulls(by: { trackId?: string; userId?: string; sessionId?: string }): VoicePullRow[] {
    if (by.trackId !== undefined) {
      return this.all('DELETE FROM voice_pulls WHERE track_id = ? RETURNING *', by.trackId);
    }
    if (by.userId !== undefined) {
      return this.all('DELETE FROM voice_pulls WHERE user_id = ? RETURNING *', by.userId);
    }
    if (by.sessionId !== undefined) {
      return this.all('DELETE FROM voice_pulls WHERE session_id = ? RETURNING *', by.sessionId);
    }
    return this.all('DELETE FROM voice_pulls RETURNING *');
  }

  /** Pulled voice tracks, for the meter: each is one listener receiving one microphone. */
  voicePullCount(): number {
    return this.first<{ n: number }>('SELECT count(*) AS n FROM voice_pulls')?.n ?? 0;
  }

  // --- Cameras in the voice channel (docs/PROTOCOL.md 7.7) ---

  private cameraOf(row: Row): CameraTrackRow {
    return {
      track_id: row['track_id'] as string,
      user_id: row['user_id'] as string,
      session_id: row['session_id'] as string,
      track_name: row['track_name'] as string,
      mid: row['mid'] as string,
      rids: JSON.parse(row['rids_json'] as string) as string[],
      published_at: row['published_at'] as number,
    };
  }

  insertCameraTrack(t: CameraTrackRow): void {
    this.sql.exec(
      `INSERT INTO camera_tracks
         (track_id, user_id, session_id, track_name, mid, rids_json, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      t.track_id,
      t.user_id,
      t.session_id,
      t.track_name,
      t.mid,
      JSON.stringify(t.rids),
      t.published_at,
    );
  }

  cameraTrack(trackId: string): CameraTrackRow | null {
    const row = this.first<Row>('SELECT * FROM camera_tracks WHERE track_id = ?', trackId);
    return row ? this.cameraOf(row) : null;
  }

  cameraTrackOf(userId: string): CameraTrackRow | null {
    const row = this.first<Row>('SELECT * FROM camera_tracks WHERE user_id = ?', userId);
    return row ? this.cameraOf(row) : null;
  }

  /** Every camera on, oldest first. */
  cameraTracks(): CameraTrackRow[] {
    return this.all<Row>('SELECT * FROM camera_tracks ORDER BY published_at, track_id').map((r) =>
      this.cameraOf(r),
    );
  }

  deleteCameraTrack(trackId: string): void {
    this.sql.exec('DELETE FROM camera_tracks WHERE track_id = ?', trackId);
  }

  upsertCameraPull(p: CameraPullRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO camera_pulls (session_id, track_id, user_id, mid, rid)
       VALUES (?, ?, ?, ?, ?)`,
      p.session_id,
      p.track_id,
      p.user_id,
      p.mid,
      p.rid,
    );
  }

  cameraPull(sessionId: string, trackId: string): CameraPullRow | null {
    return this.first(
      'SELECT * FROM camera_pulls WHERE session_id = ? AND track_id = ?',
      sessionId,
      trackId,
    );
  }

  setCameraPullRid(sessionId: string, trackId: string, rid: string): void {
    this.sql.exec(
      'UPDATE camera_pulls SET rid = ? WHERE session_id = ? AND track_id = ?',
      rid,
      sessionId,
      trackId,
    );
  }

  deleteCameraPull(sessionId: string, trackId: string): void {
    this.sql.exec(
      'DELETE FROM camera_pulls WHERE session_id = ? AND track_id = ?',
      sessionId,
      trackId,
    );
  }

  /** Removes and returns the pulls of a camera, of a viewer, of a session, or all of them. */
  takeCameraPulls(by: { trackId?: string; userId?: string; sessionId?: string }): CameraPullRow[] {
    if (by.trackId !== undefined) {
      return this.all('DELETE FROM camera_pulls WHERE track_id = ? RETURNING *', by.trackId);
    }
    if (by.userId !== undefined) {
      return this.all('DELETE FROM camera_pulls WHERE user_id = ? RETURNING *', by.userId);
    }
    if (by.sessionId !== undefined) {
      return this.all('DELETE FROM camera_pulls WHERE session_id = ? RETURNING *', by.sessionId);
    }
    return this.all('DELETE FROM camera_pulls RETURNING *');
  }

  /** The layer of every pulled camera, for the meter: each is one viewer receiving one camera. */
  cameraPullLayers(): { rid: string | null }[] {
    return this.all('SELECT rid FROM camera_pulls');
  }

  // --- Usage meter ---

  /** Every held slot with the layer its viewer pulled, if any. */
  /** Every held slot with the layer and codec its viewer pulled (null before the pull). */
  slotLayers(): { stream_id: string; rid: string | null; codec: VideoCodec | null }[] {
    return this.all<{ stream_id: string; rid: string | null; mids_json: string | null }>(
      `SELECT s.stream_id, sub.rid, sub.mids_json FROM slots s
       LEFT JOIN subscriptions sub ON sub.slot_id = s.slot_id`,
    ).map(({ mids_json, ...rest }) => {
      const mids = mids_json ? (JSON.parse(mids_json) as SubscriptionRow['mids']) : [];
      return { ...rest, codec: mids.find((m) => m.kind === 'video')?.codec ?? null };
    });
  }

  meter(now: number): MeterRow {
    this.meterRow ??= this.first<MeterRow>(
      'SELECT last_at, viewer_mbit_s, join_mbps, viewer_s, stream_s FROM meter WHERE id = 1',
    );
    return {
      ...(this.meterRow ?? {
        last_at: now,
        viewer_mbit_s: 0,
        join_mbps: 0,
        viewer_s: 0,
        stream_s: 0,
      }),
    };
  }

  /** Sets the running totals in memory; saveMeter writes them. */
  setMeter(m: MeterRow): void {
    this.meterRow = { ...m };
    this.meterDirty = true;
  }

  /**
   * Writes the running totals if they changed. Needed only when what accrues per second changes
   * (a slot, pull or stream comes or goes), after a join, and after a flush: in between, the
   * stored row plus the same rates from its last_at gives the same totals, so an eviction loses
   * nothing (room/meter.ts).
   */
  saveMeter(): void {
    const m = this.meterRow;
    if (!m || !this.meterDirty) return;
    this.meterDirty = false;
    this.sql.exec(
      `INSERT INTO meter (id, last_at, viewer_mbit_s, join_mbps, viewer_s, stream_s)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_at = excluded.last_at,
         viewer_mbit_s = excluded.viewer_mbit_s, join_mbps = excluded.join_mbps,
         viewer_s = excluded.viewer_s, stream_s = excluded.stream_s`,
      m.last_at,
      m.viewer_mbit_s,
      m.join_mbps,
      m.viewer_s,
      m.stream_s,
    );
  }

  getNumber(key: string): number | null {
    return this.getMeta<number>(key);
  }

  setNumber(key: string, value: number | null): void {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.setMeta(key, value);
  }

  getText(key: string): string | null {
    return this.getMeta<string>(key);
  }

  setText(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.setMeta(key, value);
  }

  // --- Cleanup and deadlines ---

  /** Removes every slot and queue entry of a connection; returns the streams affected. */
  releaseConnection(connectionId: string): Set<string> {
    const slots = this.all<{ slot_id: string; stream_id: string }>(
      'DELETE FROM slots WHERE connection_id = ? RETURNING slot_id, stream_id',
      connectionId,
    );
    this.forgetLeases(slots.map((r) => r.slot_id));
    const queued = this.all<{ stream_id: string }>(
      'DELETE FROM queue WHERE connection_id = ? RETURNING stream_id',
      connectionId,
    );
    return new Set([...slots, ...queued].map((r) => r.stream_id));
  }

  clearViewers(): void {
    this.sql.exec('DELETE FROM slots');
    this.leases = new Map();
    this.storedLeases.clear();
    this.sql.exec('DELETE FROM queue');
  }

  /** Everything SFU-related, when the room closes: the caller closes the tracks first. */
  clearRtc(): void {
    this.sql.exec('DELETE FROM streams');
    this.sql.exec('DELETE FROM stream_sfu');
    this.sql.exec('DELETE FROM publications');
    this.sql.exec('DELETE FROM subscriptions');
    this.sql.exec('DELETE FROM viewer_sessions');
    this.sql.exec('DELETE FROM voice_participants');
    this.sql.exec('DELETE FROM voice_tracks');
    this.sql.exec('DELETE FROM voice_pulls');
    this.sql.exec('DELETE FROM camera_tracks');
    this.sql.exec('DELETE FROM camera_pulls');
  }

  allPublications(): PublicationRow[] {
    return this.all<Row>('SELECT * FROM publications').map(
      (r) => this.publicationOf(r) as PublicationRow,
    );
  }

  allSubscriptions(): SubscriptionRow[] {
    return this.all<Row>('SELECT * FROM subscriptions').map((r) => this.subscriptionOf(r));
  }

  expiredSlots(now: number): SlotRow[] {
    const leases = this.leaseMap();
    if (![...leases.values()].some((t) => t <= now)) return [];
    return this.all<SlotRow>('SELECT * FROM slots')
      .map((s) => this.withLease(s))
      .filter((s) => s.expires_at <= now);
  }

  expiredOffers(now: number): QueueRow[] {
    return this.all<QueueRow>(
      'SELECT * FROM queue WHERE offer_expires_at IS NOT NULL AND offer_expires_at <= ?',
      now,
    );
  }

  /** Whether anyone waits in a queue (for a slot, or with an offer). */
  anyQueued(): boolean {
    return (this.first<{ n: number }>('SELECT count(*) AS n FROM queue')?.n ?? 0) > 0;
  }

  /** The earliest offer, announce or helper-grace deadline, if any (leases: nextLeaseExpiry). */
  nextDeadline(): number | null {
    const row = this.first<{ t: number | null }>(
      `SELECT min(t) AS t FROM (
         SELECT min(offer_expires_at) AS t FROM queue
         UNION ALL SELECT min(announce_by) FROM publications WHERE stream_id IS NULL
         UNION ALL SELECT min(grace_until) FROM stream_sfu
       )`,
    );
    return row?.t ?? null;
  }
}
