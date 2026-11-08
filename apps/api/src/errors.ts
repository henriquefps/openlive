// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import type { ErrorCode } from '@openlive/protocol';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// The API never returns user-facing text: only a code plus
// parameters, which the web app translates.
export type ErrorBody<P extends Record<string, unknown> = Record<string, unknown>> = {
  code: string;
} & P;

export function apiError<P extends Record<string, unknown>>(
  code: string,
  params?: P,
): ErrorBody<P> {
  return { ...params, code } as ErrorBody<P>;
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  params?: Record<string, unknown>,
): Response {
  return c.json(apiError(code, params), status);
}

/**
 * Thrown by REST handlers and the data layer to end the request with an error body; the app's
 * onError turns it into the response.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    readonly params?: Record<string, unknown>,
  ) {
    super(code);
  }
}

/**
 * Cloudflare's error once the instance used up a daily free-tier limit of Durable Objects, as
 * production saw it: "Exceeded allowed rows written in Durable Objects free tier." (also rows
 * read, requests, duration). Every DO call fails until 00:00 UTC.
 */
export function isDoQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /exceeded allowed .* in durable objects free tier/i.test(message);
}

/** Seconds until the free-tier limits reset (00:00 UTC). */
export function secondsToUtcMidnight(now = Date.now()): number {
  const day = 86_400_000;
  return Math.max(1, Math.ceil((Math.floor(now / day + 1) * day - now) / 1000));
}

/**
 * The answer to a request that hit the DO free-tier limit: 503 do_quota_exceeded with
 * Retry-After. A browser cannot read the status of a refused WebSocket upgrade, so an upgrade is
 * accepted instead, gets error { code: do_quota_exceeded } and is closed with 1013 ("try again
 * later"), which the web app waits out (PROTOCOL.md 6, 1.15).
 */
export function doQuotaResponse(
  c: Context,
  brake?: { retryAfter: number; releasesAt: number },
  retryAfterS?: number,
): Response {
  const retryAfter = brake?.retryAfter ?? retryAfterS ?? secondsToUtcMidnight();
  // The instance's own limits brake answers the same, with a reason the clients
  // show apart ("paused by the instance's limits brake") and its release time.
  const params = brake ? { reason: LIMITS_BRAKE_REASON, releasesAt: brake.releasesAt } : {};
  if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.send(
      JSON.stringify({ type: 'error', payload: { code: 'do_quota_exceeded', ...params } }),
    );
    server.close(1013, brake ? LIMITS_BRAKE_REASON : 'do_quota_exceeded');
    return new Response(null, { status: 101, webSocket: client });
  }
  return c.json(apiError('do_quota_exceeded', params), 503, { 'Retry-After': String(retryAfter) });
}

/** The close reason and error `reason` of a refusal by the limits brake. */
export const LIMITS_BRAKE_REASON = 'limits_brake';

/**
 * Thrown when a request handler reaches for a Durable Object while the limits brake is engaged
 * (the Worker's guarded bindings, usage/brake-guard.ts); the app's onError answers it like
 * do_quota_exceeded with the brake's reason.
 */
export class LimitsBrakeError extends Error {
  constructor(readonly releasesAt: number) {
    super('limits brake engaged');
  }
}
