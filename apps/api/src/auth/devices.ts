// SPDX-License-Identifier: AGPL-3.0-only
import type { Device, DeviceArch, DeviceOs } from '@openlive/protocol';
import { newId, randomToken, sha256Hex } from '../db/util';

// Helper pairing (docs/PROTOCOL.md 11.1), in the style of the OAuth device flow
// (RFC 8628): the helper holds a secret device code and polls; the signed-in person types the short
// user code on /link and approves; the next poll creates the device and returns its token once.
// Device codes and device tokens are stored only as SHA-256 hashes. Tokens never reach a log.

/** How long a pairing code lives. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** Initial polling interval; slow_down adds SLOW_DOWN_STEP_MS each time (RFC 8628 3.5). */
export const POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_STEP_MS = 5_000;
/** lastSeenAt is written at most this often, so a busy helper does not write D1 on every call. */
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000;

/** No 0/O, 1/I/L: the code is read off one screen and typed on another. */
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const USER_CODE_LENGTH = 6;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 'k7f-2qm', 'K7F2QM' → 'K7F2QM'; null when it cannot be a user code. */
export function normalizeUserCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== USER_CODE_LENGTH) return null;
  return [...code].every((ch) => USER_CODE_ALPHABET.includes(ch)) ? code : null;
}

/** 'K7F2QM' → 'K7F-2QM', as shown to people. */
export const formatUserCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`;

function randomUserCode(): string {
  // 256 is not a multiple of 31; rejection sampling keeps every character equally likely.
  const out: string[] = [];
  while (out.length < USER_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < USER_CODE_LENGTH) {
        out.push(USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length] as string);
      }
    }
  }
  return out.join('');
}

export interface HelperFacts {
  name?: string | undefined;
  os: DeviceOs;
  arch: DeviceArch;
  helperVersion: string;
}

export interface NewDeviceCode {
  deviceCode: string;
  userCode: string;
  expiresInMs: number;
  intervalMs: number;
}

export async function createDeviceCode(
  db: D1Database,
  facts: HelperFacts,
  now: number,
): Promise<NewDeviceCode> {
  await db.prepare('DELETE FROM device_codes WHERE expires_at <= ?').bind(now).run();
  const deviceCode = randomToken();
  const hash = await sha256Hex(deviceCode);
  // A collision with a live code is possible (31^6 codes); retry with another.
  for (let attempt = 0; ; attempt++) {
    const userCode = randomUserCode();
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO device_codes
           (device_code_hash, user_code, name, os, arch, helper_version, interval_ms, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        hash,
        userCode,
        facts.name ?? null,
        facts.os,
        facts.arch,
        facts.helperVersion,
        POLL_INTERVAL_MS,
        now,
        now + DEVICE_CODE_TTL_MS,
      )
      .run();
    if (res.meta.changes > 0) {
      return {
        deviceCode,
        userCode: formatUserCode(userCode),
        expiresInMs: DEVICE_CODE_TTL_MS,
        intervalMs: POLL_INTERVAL_MS,
      };
    }
    if (attempt >= 5) throw new Error('could not allocate a user code');
  }
}

interface DeviceCodeRow {
  device_code_hash: string;
  user_code: string;
  name: string | null;
  os: DeviceOs;
  arch: DeviceArch;
  helper_version: string;
  interval_ms: number;
  expires_at: number;
  last_poll_at: number | null;
  approved_by: string | null;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; intervalMs: number }
  | { status: 'expired' }
  | { status: 'approved'; deviceId: string; userId: string; deviceToken: string };

/** One poll of the helper (RFC 8628 3.4 and 3.5). */
export async function pollDeviceCode(
  db: D1Database,
  deviceCode: string,
  now: number,
): Promise<PollResult> {
  if (!TOKEN_PATTERN.test(deviceCode)) return { status: 'expired' };
  const hash = await sha256Hex(deviceCode);
  const row = await db
    .prepare('SELECT * FROM device_codes WHERE device_code_hash = ?')
    .bind(hash)
    .first<DeviceCodeRow>();
  if (!row || row.expires_at <= now) return { status: 'expired' };

  if (row.approved_by === null) {
    if (row.last_poll_at !== null && now - row.last_poll_at < row.interval_ms) {
      const intervalMs = row.interval_ms + SLOW_DOWN_STEP_MS;
      await db
        .prepare(
          'UPDATE device_codes SET interval_ms = ?, last_poll_at = ? WHERE device_code_hash = ?',
        )
        .bind(intervalMs, now, hash)
        .run();
      return { status: 'slow_down', intervalMs };
    }
    await db
      .prepare('UPDATE device_codes SET last_poll_at = ? WHERE device_code_hash = ?')
      .bind(now, hash)
      .run();
    return { status: 'pending' };
  }

  // Approved: exchange the code for a device, once. The DELETE decides who wins a race.
  const deviceToken = randomToken();
  const deviceId = newId('d');
  const [deleted] = await db.batch([
    db.prepare('DELETE FROM device_codes WHERE device_code_hash = ? RETURNING 1').bind(hash),
    db
      .prepare(
        `INSERT INTO devices (id, user_id, name, os, arch, helper_version, token_hash, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE changes() > 0`,
      )
      .bind(
        deviceId,
        row.approved_by,
        row.name ?? 'Helper',
        row.os,
        row.arch,
        row.helper_version,
        await sha256Hex(deviceToken),
        now,
      ),
  ]);
  if (!deleted?.results.length) return { status: 'expired' };
  return { status: 'approved', deviceId, userId: row.approved_by, deviceToken };
}

export interface PendingCode {
  userCode: string;
  name?: string;
  os: DeviceOs;
  arch: DeviceArch;
  helperVersion: string;
  expiresAt: number;
}

/** A pairing waiting for approval, by its user code; null when unknown, expired or approved. */
export async function pendingCode(
  db: D1Database,
  userCode: string,
  now: number,
): Promise<PendingCode | null> {
  const row = await db
    .prepare(
      'SELECT * FROM device_codes WHERE user_code = ? AND expires_at > ? AND approved_by IS NULL',
    )
    .bind(userCode, now)
    .first<DeviceCodeRow & { expires_at: number }>();
  if (!row) return null;
  return {
    userCode: formatUserCode(row.user_code),
    ...(row.name !== null ? { name: row.name } : {}),
    os: row.os,
    arch: row.arch,
    helperVersion: row.helper_version,
    expiresAt: row.expires_at,
  };
}

/** Approves a pending code for `userId`; the given facts replace what the helper sent. */
export async function approveCode(
  db: D1Database,
  userId: string,
  userCode: string,
  facts: {
    name: string;
    os?: DeviceOs | undefined;
    arch?: DeviceArch | undefined;
    helperVersion?: string | undefined;
  },
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE device_codes SET approved_by = ?1, approved_at = ?2, name = ?3,
         os = coalesce(?4, os), arch = coalesce(?5, arch), helper_version = coalesce(?6, helper_version)
       WHERE user_code = ?7 AND expires_at > ?2 AND approved_by IS NULL`,
    )
    .bind(
      userId,
      now,
      facts.name,
      facts.os ?? null,
      facts.arch ?? null,
      facts.helperVersion ?? null,
      userCode,
    )
    .run();
  return res.meta.changes > 0;
}

/** The live device a bearer token names, or null. Refreshes last_seen_at now and then. */
export async function resolveDeviceToken(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ userId: string; deviceId: string } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT d.id, d.user_id, d.last_seen_at FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.deleted_at IS NULL
         AND u.banned_at IS NULL`,
    )
    .bind(await sha256Hex(token))
    .first<{ id: string; user_id: string; last_seen_at: number | null }>();
  if (!row) return null;
  if (row.last_seen_at === null || now - row.last_seen_at >= LAST_SEEN_EVERY_MS) {
    await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { userId: row.user_id, deviceId: row.id };
}

interface DeviceRow {
  id: string;
  name: string;
  os: DeviceOs;
  arch: DeviceArch;
  helper_version: string;
  created_at: number;
  last_seen_at: number | null;
}

export async function listDevices(db: D1Database, userId: string): Promise<Device[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, os, arch, helper_version, created_at, last_seen_at FROM devices
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    )
    .bind(userId)
    .all<DeviceRow>();
  return results.map((r) => ({
    deviceId: r.id,
    name: r.name,
    os: r.os,
    arch: r.arch,
    helperVersion: r.helper_version,
    createdAt: r.created_at,
    ...(r.last_seen_at !== null ? { lastSeenAt: r.last_seen_at } : {}),
  }));
}

/** Revokes one of the user's devices; false when it is not theirs or already revoked. */
export async function revokeDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      'UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .bind(now, deviceId, userId)
    .run();
  return res.meta.changes > 0;
}
