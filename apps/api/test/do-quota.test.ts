// SPDX-License-Identifier: AGPL-3.0-only
import { exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoomDO } from '../src/do/room';
import { isDoQuotaError, secondsToUtcMidnight } from '../src/errors';
import { DEV_USER_HEADER } from '../src/room/identity';
import { newRoom, seed, upgrade, USERS } from './room-helpers';

// The Durable Objects free-tier limit: requests that hit it end with 503
// do_quota_exceeded (a socket: error frame, then close 1013).

beforeAll(seed);
afterEach(() => {
  vi.restoreAllMocks();
});

const QUOTA_ERROR = 'Exceeded allowed rows written in Durable Objects free tier.';

describe('do_quota_exceeded', () => {
  it('recognizes the error and counts down to 00:00 UTC', () => {
    expect(isDoQuotaError(new Error(QUOTA_ERROR))).toBe(true);
    expect(
      isDoQuotaError(new Error('Exceeded allowed duration in Durable Objects free tier.')),
    ).toBe(true);
    expect(isDoQuotaError(new Error('boom'))).toBe(false);
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 28, 23, 59, 0))).toBe(60);
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 28, 0, 0, 0))).toBe(86_400);
  });

  it('answers a REST call with 503 and Retry-After', async () => {
    const roomId = await newRoom();
    vi.spyOn(RoomDO.prototype, 'rtcViewerSession').mockImplementation(async () => {
      throw new Error(QUOTA_ERROR);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await exports.default.fetch(`http://localhost/api/rtc/rooms/${roomId}/session`, {
      method: 'POST',
      headers: { [DEV_USER_HEADER]: USERS.member1.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDescription: { type: 'offer', sdp: 'v=0\r\n' } }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'do_quota_exceeded' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('accepts a socket only to send the error and close it with 1013', async () => {
    const roomId = await newRoom();
    vi.spyOn(RoomDO.prototype, 'fetch').mockImplementation(async () => {
      throw new Error(QUOTA_ERROR);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upgrade(roomId, USERS.member1.id);
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no socket');
    const frames: string[] = [];
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('message', (e) => frames.push(e.data as string));
      ws.addEventListener('close', (e) => resolve(e.code));
    });
    ws.accept();
    expect(await closed).toBe(1013);
    expect(frames.map((f) => JSON.parse(f))).toEqual([
      { type: 'error', payload: { code: 'do_quota_exceeded' } },
    ]);
  });
});
