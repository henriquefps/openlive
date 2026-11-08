// SPDX-License-Identifier: AGPL-3.0-only
// Durable Objects under the limits brake. Alarms run without the Worker, and a
// socket that is already open sends its messages straight to its object, so refusing new
// requests in the Worker is not enough: an object the brake reaches closes its sockets with 1013
// (the close the Worker uses when Cloudflare refuses, with reason `limits_brake`),
// deletes its alarm and stays dormant until the brake's release time. The cron tells the objects
// that may be awake (usage/limits-monitor.ts); a room also checks the brake on its own alarm and
// messages (the isolate's cached copy, a D1 read at most once a minute), so one the cron missed
// stops at its next wake-up instead of looping.

import { LIMITS_BRAKE_REASON } from '../errors';
import { cachedBrakeState, isEngaged } from '../usage/limits-brake';
/** Standard 1013 "try again later", as for do_quota_exceeded (PROTOCOL.md 1.15). */
export const BRAKE_CLOSE = 1013;
/** Inside an object the brake's state is re-read at most this often. */
export const OBJECT_BRAKE_CACHE_MS = 60_000;

const ERROR_FRAME = JSON.stringify({
  type: 'error',
  payload: { code: 'do_quota_exceeded', reason: LIMITS_BRAKE_REASON },
});

/** Sends the brake's error and closes every socket of the object; returns how many. */
export function closeForBrake(ctx: DurableObjectState): number {
  const sockets = ctx.getWebSockets();
  for (const ws of sockets) {
    try {
      ws.send(ERROR_FRAME);
      ws.close(BRAKE_CLOSE, LIMITS_BRAKE_REASON);
    } catch {
      // Already closing.
    }
  }
  return sockets.length;
}

/** The release time when the brake is engaged now, else null (no D1 read when cached). */
export async function brakeUntil(db: D1Database, now: number = Date.now()): Promise<number | null> {
  const state = await cachedBrakeState(db, now, OBJECT_BRAKE_CACHE_MS);
  return isEngaged(state, now) ? state.engaged.until : null;
}

/**
 * The object's dormancy, in memory: while it holds, the object sets no alarm. Memory is enough:
 * an evicted object has no alarm left (deleted) and the Worker lets nothing reach it until the
 * brake releases, and the first request after that finds the time passed.
 */
export class Dormancy {
  private until = 0;

  get active(): boolean {
    return Date.now() < this.until;
  }

  /** Goes dormant until `until`: closes every socket and deletes the alarm. */
  async sleep(ctx: DurableObjectState, until: number): Promise<number> {
    this.until = Math.max(this.until, until);
    const closed = closeForBrake(ctx);
    await ctx.storage.deleteAlarm();
    return closed;
  }

  /** A request the Worker let through: the brake is off, so is the dormancy. */
  wake(): void {
    this.until = 0;
  }
}
