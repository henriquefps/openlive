// SPDX-License-Identifier: AGPL-3.0-only
import type { Message, MessageType, PayloadOf, Role } from '@openlive/protocol';
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { RoomStore } from '../src/room/store';
import type { RoomStream } from '../src/room/types';
import { DEV_DEVICE_HEADER, DEV_USER_HEADER } from '../src/room/identity';

export const SPACE_ID = 's1';

/** Users seeded once per test file: one per role, plus an outsider with no membership. */
export const USERS = {
  owner: { id: 'u_owner', role: 'owner' },
  admin: { id: 'u_admin', role: 'admin' },
  member1: { id: 'u_member1', role: 'member' },
  member2: { id: 'u_member2', role: 'member' },
  guest1: { id: 'u_guest1', role: 'guest' },
  guest2: { id: 'u_guest2', role: 'guest' },
  outsider: { id: 'u_outsider', role: null },
} as const satisfies Record<string, { id: string; role: Role | null }>;

export async function seed(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = Date.now();
  const users = Object.values(USERS);
  await env.DB.batch([
    ...users.map((u) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)',
      ).bind(u.id, `Name ${u.id}`, now),
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO spaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(SPACE_ID, 'Space', 'space', USERS.owner.id, now),
    ...users
      .filter((u) => u.role !== null)
      .map((u) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        ).bind(SPACE_ID, u.id, u.role, now),
      ),
  ]);
}

let roomCounter = 0;

/** A fresh fixed room per test, so each test gets its own RoomDO. */
export async function newRoom(
  extra: { archivedAt?: number; settings?: Record<string, unknown> } = {},
): Promise<string> {
  roomCounter += 1;
  const id = `r_${roomCounter}_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO rooms (id, space_id, kind, name, slug, settings_json, created_at, archived_at)
     VALUES (?, ?, 'fixed', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      SPACE_ID,
      `Room ${roomCounter}`,
      id,
      JSON.stringify(extra.settings ?? {}),
      Date.now(),
      extra.archivedAt ?? null,
    )
    .run();
  return id;
}

export function roomStub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId));
}

/** The RoomDO's store, for tests that move its in-memory state (meter, leases). */
export function storeOf(instance: unknown): RoomStore {
  return (instance as { store: RoomStore }).store;
}

/**
 * Moves the meter's last accrual `ms` into the past, as if that much time went by. The running
 * totals live in memory between writes, so the stored row alone is not enough.
 */
export function elapseMeter(roomId: string, ms: number): Promise<void> {
  return runInDurableObject(roomStub(roomId), (instance) => {
    const store = storeOf(instance);
    const m = store.meter(Date.now());
    store.setMeter({ ...m, last_at: m.last_at - ms });
    store.saveMeter();
  });
}

export function testStream(streamId: string, viewerLimit: number): RoomStream {
  return {
    streamId,
    userId: USERS.owner.id,
    deviceId: 'd_owner',
    source: { kind: 'screen', label: 'Screen 1' },
    preset: 'game',
    hasAudio: false,
    paused: false,
    startedAt: Date.now(),
    viewerLimit,
  };
}

export function upgrade(roomId: string, userId?: string, deviceId?: string): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (userId) headers[DEV_USER_HEADER] = userId;
  if (deviceId) headers[DEV_DEVICE_HEADER] = deviceId;
  return exports.default.fetch(`http://localhost/ws/rooms/${roomId}`, { headers });
}

type Of<T extends MessageType> = Extract<Message, { type: T }>;

const TIMEOUT_MS = 2_000;

/** A test-side room connection that buffers every received message. */
export class Client {
  private readonly inbox: Message[] = [];
  private wake: (() => void) | null = null;
  private nextId = 0;
  readonly closed: Promise<{ code: number }>;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      this.inbox.push(JSON.parse(e.data as string) as Message);
      this.wake?.();
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => resolve({ code: e.code }));
    });
    ws.accept();
  }

  /** Wraps the socket of an accepted upgrade response. */
  static adopt(res: Response): Client {
    if (!res.webSocket) throw new Error('no webSocket on the upgrade response');
    return new Client(res.webSocket);
  }

  /** Opens a socket; with `deviceId`, as that user's paired helper (development identity). */
  static async open(roomId: string, userId: string, deviceId?: string): Promise<Client> {
    const res = await upgrade(roomId, userId, deviceId);
    expect(res.status).toBe(101);
    if (!res.webSocket) throw new Error('no webSocket on the upgrade response');
    return new Client(res.webSocket);
  }

  /** Opens a socket and completes the handshake. */
  static async join(
    roomId: string,
    userId: string,
    hello: Partial<PayloadOf<'hello'>> = {},
  ): Promise<{ client: Client; welcome: PayloadOf<'welcome'> }> {
    // A helper hello comes with the device identity it names, as a real device token would.
    const device = hello.client === 'helper' ? hello.deviceId : undefined;
    const client = await Client.open(roomId, userId, device);
    const id = client.send('hello', {
      protocol: { major: 1, minor: 0 },
      client: 'web',
      clientVersion: '0.1.0',
      ...hello,
    });
    const welcome = await client.take('welcome');
    expect(welcome.id).toBe(id);
    return { client, welcome: welcome.payload };
  }

  /** Sends a request with a fresh id and returns the id. */
  send<T extends MessageType>(type: T, payload: PayloadOf<T>): string {
    const id = String(++this.nextId);
    this.ws.send(JSON.stringify({ type, id, payload }));
    return id;
  }

  /** Sends a request and returns its reply (any type, matched by id). */
  async request<T extends MessageType>(type: T, payload: PayloadOf<T>): Promise<Message> {
    const id = this.send(type, payload);
    return this.takeWhere((m) => m.id === id);
  }

  raw(frame: string): void {
    this.ws.send(frame);
  }

  /** Removes and returns the first buffered message of `type`, waiting for one if needed. */
  take<T extends MessageType>(type: T, where: (m: Of<T>) => boolean = () => true): Promise<Of<T>> {
    return this.takeWhere((m) => m.type === type && where(m as Of<T>)) as Promise<Of<T>>;
  }

  async takeWhere(match: (m: Message) => boolean): Promise<Message> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Message;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timed out; inbox: ${JSON.stringify(this.inbox.map((m) => m.type))}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /**
   * Waits until everything the server sent before now has arrived (a round trip; replies are
   * ordered after earlier events), then returns the buffered messages of `type` and drops them.
   */
  async drain<T extends MessageType>(type: T): Promise<Of<T>[]> {
    const ack = await this.request('queue.leave', { streamId: 'st_sync' });
    expect(ack.type).toBe('ack');
    const found = this.inbox.filter((m) => m.type === type) as Of<T>[];
    this.inbox.splice(0, this.inbox.length, ...this.inbox.filter((m) => m.type !== type));
    return found;
  }

  /** Returns the buffered messages of `type` and drops them, without waiting (sync first). */
  drainAll<T extends MessageType>(type: T): Of<T>[] {
    const found = this.inbox.filter((m) => m.type === type) as Of<T>[];
    this.inbox.splice(0, this.inbox.length, ...this.inbox.filter((m) => m.type !== type));
    return found;
  }

  close(): void {
    this.ws.close(1000);
  }
}
