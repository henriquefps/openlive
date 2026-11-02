// SPDX-License-Identifier: AGPL-3.0-only
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';

// Counts what a scenario costs against the Workers Free daily limits (src/usage/free-tier.ts),
// the way Cloudflare counts them:
// - Durable Object rows written and read: every statement's cursor.rowsWritten / rowsRead (index
//   rows included), plus one row written per setAlarm or deleteAlarm.
// - Durable Object requests: fetch (WebSocket upgrades), RPC calls, alarms, and incoming WebSocket
//   messages (counted apart: the docs apply a 20:1 ratio to them for billing).
// - D1 rows read and written: the meta of every D1 result.
// - Worker requests: every request the test sends to the Worker.
// - Console lines: every console call while counting; with the invocations above, the Workers
//   Logs events.
// Test-only: it patches the objects' storage and entry points in place (runInDurableObject), the
// D1 statement prototype, and the Worker's fetch.

export interface SqlRecord {
  object: string;
  source: string;
  statements: number;
  rowsWritten: number;
  rowsRead: number;
}

export interface Totals {
  doRowsWritten: number;
  doRowsRead: number;
  /** fetch, RPC and alarm invocations. */
  doRequests: number;
  /** Incoming WebSocket messages (each is a request; billing divides them by 20). */
  doWsMessages: number;
  d1RowsWritten: number;
  d1RowsRead: number;
  workerRequests: number;
  /** console.log/info/warn/error/debug calls, each a Workers Logs event when sampled. */
  consoleLines: number;
}

interface Entry {
  object: string;
  query: string;
  bindings: unknown[];
  cursor?: { rowsWritten: number; rowsRead: number };
  rowsWritten?: number;
}

/** The DO methods the runtime or other code calls from outside (requests). */
const ENTRY_POINTS: Record<string, string[]> = {
  RoomDO: [
    'fetch',
    'alarm',
    'webSocketClose',
    'webSocketError',
    'upsertStream',
    'checkSlot',
    'kick',
    'streamsOf',
    'revokeAccess',
    'revokeDevice',
    'closeRoom',
    'visibilityChanged',
    'setExpiry',
    'permissionsChanged',
    'settingsChanged',
    'flushUsage',
    'chatUnread',
    'eraseChatAuthor',
    'liveStreamIds',
    'putThumbnail',
    'rtcPublish',
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
  ],
  SpaceDO: ['fetch', 'alarm', 'webSocketClose', 'webSocketError', 'roomPresence', 'accessChanged'],
  UserHubDO: [
    'fetch',
    'alarm',
    'webSocketClose',
    'webSocketError',
    'deviceJoinedRoom',
    'takeDeviceRooms',
    'notice',
    'revokeDevice',
    'revokeAll',
  ],
};

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** The counter the patched objects report to; a new UsageCounter takes over. */
let active: UsageCounter | null = null;

interface D1Meta {
  rows_read?: number;
  rows_written?: number;
}

export class UsageCounter {
  private entries: Entry[] = [];
  private on = true;
  private doRequests = 0;
  private doWsMessages = 0;
  private d1RowsWritten = 0;
  private d1RowsRead = 0;
  private workerRequests = 0;
  private consoleLines = 0;

  /** Makes this counter the one the patched objects report to. */
  activate(): this {
    // The patched objects outlive a counter: they report to whichever is active.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    active = this;
    return this;
  }

  /**
   * Becomes the active counter and counts D1 and the Worker's requests from now on
   * (vi.restoreAllMocks undoes it).
   */
  install(): this {
    this.activate();
    const db = env.DB.prepare('SELECT 1');
    const proto = Object.getPrototypeOf(db) as {
      all: (this: unknown) => Promise<{ results: unknown[]; meta: D1Meta }>;
      run: (this: unknown) => Promise<{ meta: D1Meta }>;
      first: (this: unknown, column?: string) => Promise<unknown>;
    };
    const all = proto.all;
    const run = proto.run;
    vi.spyOn(proto, 'all').mockImplementation(async function (this: unknown) {
      const r = await all.call(this);
      active?.d1(r.meta);
      return r;
    });
    vi.spyOn(proto, 'run').mockImplementation(async function (this: unknown) {
      const r = await run.call(this);
      active?.d1(r.meta);
      return r;
    });
    // first() hides its meta: the same query through all().
    vi.spyOn(proto, 'first').mockImplementation(async function (this: unknown, column?: string) {
      const r = await all.call(this);
      active?.d1(r.meta);
      const row = (r.results[0] ?? null) as Record<string, unknown> | null;
      if (row === null) return null;
      return column === undefined ? row : (row[column] ?? null);
    });
    const dbProto = Object.getPrototypeOf(env.DB) as {
      batch: (this: unknown, s: unknown[]) => Promise<{ meta: D1Meta }[]>;
    };
    const batch = dbProto.batch;
    vi.spyOn(dbProto, 'batch').mockImplementation(async function (this: unknown, s: unknown[]) {
      const rs = await batch.call(this, s);
      for (const r of rs) active?.d1(r.meta);
      return rs;
    });
    const worker = exports.default as { fetch: (...args: unknown[]) => Promise<Response> };
    const fetch = worker.fetch.bind(worker);
    vi.spyOn(worker, 'fetch').mockImplementation((...args: unknown[]) => {
      if (active?.on) active.workerRequests += 1;
      return fetch(...args);
    });
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        if (active?.on) active.consoleLines += 1;
        original(...args);
      });
    }
    return this;
  }

  private d1(meta: D1Meta | undefined): void {
    if (!this.on || !meta) return;
    this.d1RowsWritten += meta.rows_written ?? 0;
    this.d1RowsRead += meta.rows_read ?? 0;
  }

  private record(entry: Entry): void {
    if (this.on) this.entries.push(entry);
  }

  /** Patches `stub`'s storage and entry points; `object` is its class name ("RoomDO", ...). */
  async attach(stub: DurableObjectStub, object: string): Promise<void> {
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql as SqlStorage & { __counted?: boolean };
      if (sql.__counted) return;
      sql.__counted = true;
      const exec = sql.exec.bind(sql);
      sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = exec(query, ...bindings);
        active?.record({ object, query, bindings, cursor });
        return cursor;
      }) as SqlStorage['exec'];
      const storage = state.storage;
      const setAlarm = storage.setAlarm.bind(storage);
      const deleteAlarm = storage.deleteAlarm.bind(storage);
      storage.setAlarm = (async (t: number | Date) => {
        active?.record({ object, query: 'setAlarm', bindings: [], rowsWritten: 1 });
        return setAlarm(t);
      }) as DurableObjectStorage['setAlarm'];
      storage.deleteAlarm = (async () => {
        // runDurableObjectAlarm (runAlarm below) clears the alarm through here: not the app's.
        if (active?.runningAlarm) active.runningAlarm = false;
        else if ((await storage.getAlarm()) !== null) {
          active?.record({ object, query: 'deleteAlarm', bindings: [], rowsWritten: 1 });
        }
        return deleteAlarm();
      }) as DurableObjectStorage['deleteAlarm'];
      // RPC reaches prototype methods only: the class is patched once, for every instance.
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> & {
        __counted?: boolean;
      };
      if (proto.__counted) return;
      proto.__counted = true;
      for (const name of [...(ENTRY_POINTS[object] ?? []), 'webSocketMessage']) {
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          if (active?.on) {
            if (name === 'webSocketMessage') active.doWsMessages += 1;
            else active.doRequests += 1;
          }
          return (fn as (...a: unknown[]) => unknown).apply(this, args);
        };
      }
    });
  }

  /** Set while runAlarm hands the alarm to the test runner. */
  runningAlarm = false;

  /** Runs `stub`'s alarm (runDurableObjectAlarm) without counting the runner's deleteAlarm. */
  async runAlarm(stub: DurableObjectStub): Promise<boolean> {
    this.runningAlarm = true;
    try {
      return await runDurableObjectAlarm(stub);
    } finally {
      this.runningAlarm = false;
    }
  }

  pause(): void {
    this.on = false;
  }

  /** Rows per object and source, most rows written first. */
  report(): SqlRecord[] {
    const by = new Map<string, SqlRecord>();
    for (const e of this.entries) {
      const write = e.rowsWritten !== undefined || WRITE.test(e.query);
      const source = write ? sourceOf(e.object, e.query, e.bindings) : '(reads)';
      const key = `${e.object}\u0000${source}`;
      const r = by.get(key) ?? {
        object: e.object,
        source,
        statements: 0,
        rowsWritten: 0,
        rowsRead: 0,
      };
      r.statements += 1;
      r.rowsWritten += e.rowsWritten ?? e.cursor?.rowsWritten ?? 0;
      r.rowsRead += e.cursor?.rowsRead ?? 0;
      by.set(key, r);
    }
    return [...by.values()].sort(
      (a, b) => b.rowsWritten - a.rowsWritten || b.rowsRead - a.rowsRead,
    );
  }

  /** DO rows written by class. */
  rowsWrittenBy(object: string): number {
    return this.report()
      .filter((r) => r.object === object)
      .reduce((n, r) => n + r.rowsWritten, 0);
  }

  totals(): Totals {
    const report = this.report();
    return {
      doRowsWritten: report.reduce((n, r) => n + r.rowsWritten, 0),
      doRowsRead: report.reduce((n, r) => n + r.rowsRead, 0),
      doRequests: this.doRequests,
      doWsMessages: this.doWsMessages,
      d1RowsWritten: this.d1RowsWritten,
      d1RowsRead: this.d1RowsRead,
      workerRequests: this.workerRequests,
      consoleLines: this.consoleLines,
    };
  }
}

/** Which product feature a write belongs to, from its statement. */
export function sourceOf(object: string, query: string, bindings: unknown[]): string {
  if (query === 'setAlarm' || query === 'deleteAlarm') return 'alarm (set/delete)';
  if (object === 'SpaceDO') return 'space presence';
  if (object === 'UserHubDO') return 'hub';
  const q = query.replace(/\s+/g, ' ');
  if (/UPDATE slots SET expires_at/i.test(q)) return 'lease renew';
  if (/\bslots\b/i.test(q) || /\bqueue\b/i.test(q)) return 'slots and queue';
  if (/\bmeter\b/i.test(q)) return 'meter accrual';
  if (/\bmeta\b/i.test(q)) {
    const key = String(bindings[0] ?? '');
    if (key.startsWith('presence')) return 'presence push';
    if (key === 'meter_due' || key === 'quota_blocked_at' || key === 'economy') {
      return 'meter flush';
    }
    if (key === 'room' || key === 'settings') return 'room snapshot (connect)';
    return `meta ${key}`;
  }
  if (/\b(voice|camera)_/i.test(q)) return 'voice and camera';
  if (/\bchat_/i.test(q)) return 'chat';
  return 'streams and sessions';
}
