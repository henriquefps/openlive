// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import { type MetricsDataset, writeError } from './points';

// Error counts per code: every /api response with status 400 or more becomes one
// Analytics Engine point with its code. Routes that resolved a space (loadSpace, the SFU proxy's
// room check) note it, so the space's status page lists its own errors.

const spaces = new WeakMap<Request, string>();

/** The request concerns this space: its error, if any, counts there. */
export function noteSpace(request: Request, spaceId: string): void {
  spaces.set(request, spaceId);
}

/**
 * Answers that are part of a normal flow, not failures: the device pairing poll (RFC 8628) gets
 * these every few seconds until the user approves.
 */
const EXPECTED = new Set(['authorization_pending', 'slow_down']);

/** A cap per isolate, so a client looping on an error cannot spend the daily write budget. */
const MAX_PER_MINUTE = 120;
let windowStart = 0;
let written = 0;

export function errorMetrics(
  dataset: (env: Env) => MetricsDataset,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    const status = c.res.status;
    if (status < 400) return;
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      written = 0;
    }
    if (written >= MAX_PER_MINUTE) return;
    let code = String(status);
    if (c.res.headers.get('content-type')?.includes('application/json')) {
      try {
        const body: unknown = await c.res.clone().json();
        if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') {
          code = body.code.slice(0, 64);
        }
      } catch {
        // Not JSON after all: the status stands in for the code.
      }
    }
    if (EXPECTED.has(code)) return;
    written += 1;
    writeError(dataset(c.env), spaces.get(c.req.raw) ?? null, c.req.method, code, status);
  };
}
