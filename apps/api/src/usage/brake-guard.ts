// SPDX-License-Identifier: AGPL-3.0-only
// The Worker under the limits brake: every request that would wake a Durable
// Object is refused, with no D1 read and no DO request per request. The brake's state comes from
// the isolate's cached copy (refreshed at most every BRAKE_CACHE_MS). Sockets (/ws/*) are refused
// before anything else runs. API handlers get bindings whose Durable Object namespaces throw
// LimitsBrakeError when used, so exactly the routes that reach an object answer 503 (login, the
// admin panel and every D1-only route keep working); a change already saved in D1 stays saved,
// and the objects read it again when they next wake, as after a refusal by Cloudflare.

import type { MiddlewareHandler } from 'hono';
import { doQuotaResponse, LimitsBrakeError } from '../errors';
import {
  type BrakeEngagement,
  cachedBrakeState,
  isEngaged,
  retryAfterSeconds,
} from './limits-brake';

const DO_BINDINGS = ['ROOM', 'SPACE', 'USER_HUB'] as const;
const RAW = Symbol('raw env');

/** A namespace that refuses to address any object while the brake holds. */
function refusingNamespace(releasesAt: number): DurableObjectNamespace {
  return new Proxy({} as DurableObjectNamespace, {
    get() {
      throw new LimitsBrakeError(releasesAt);
    },
  });
}

/** `env` with the Durable Object namespaces replaced by refusing ones. */
export function guardedEnv(env: Env, releasesAt: number): Env {
  const guarded: Env & { [RAW]?: Env } = { ...env, [RAW]: env };
  for (const name of DO_BINDINGS) {
    (guarded as unknown as Record<string, unknown>)[name] = refusingNamespace(releasesAt);
  }
  return guarded;
}

/** The bindings as the runtime gave them (for the admin's own engage, which puts objects to sleep). */
export function rawEnv(env: Env): Env {
  return (env as Env & { [RAW]?: Env })[RAW] ?? env;
}

/** The engagement in force now, from the isolate's cached copy, or null. */
export async function engagedBrake(
  db: D1Database,
  now = Date.now(),
): Promise<BrakeEngagement | null> {
  const state = await cachedBrakeState(db, now);
  return isEngaged(state, now) ? state.engaged : null;
}

/** The answer to a request the brake refuses: 503 / close 1013 with reason limits_brake. */
export function brakeResponse(
  c: Parameters<typeof doQuotaResponse>[0],
  releasesAt: number,
  now = Date.now(),
): Response {
  return doQuotaResponse(c, {
    releasesAt,
    retryAfter: retryAfterSeconds({ until: releasesAt } as BrakeEngagement, now),
  });
}

/** /ws/*: every socket wakes an object; refused at once while the brake holds. */
export const refuseSocketsWhileBraked: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const engaged = await engagedBrake(c.env.DB);
  if (engaged) return brakeResponse(c, engaged.until);
  await next();
};

/** /api/*: the Durable Object bindings refuse while the brake holds; everything else works. */
export const guardObjectsWhileBraked: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const engaged = await engagedBrake(c.env.DB);
  if (engaged) c.env = guardedEnv(c.env, engaged.until);
  await next();
};
