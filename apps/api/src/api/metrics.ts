// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../errors';
import { noteSpace } from '../metrics/errors';
import { type MetricsDataset, metricsDataset, writeViewer } from '../metrics/points';
import {
  emptySummary,
  loadStatus,
  STATUS_RANGES,
  type StatusRange,
  type StatusResult,
  type StatusSummary,
} from '../metrics/status';
import { roomAccess } from '../room/access';
import { saveWorkersPlan, workersPlanSetting } from '../db/platform';
import { loadLimits, WORKERS_PLANS } from '../usage/cloudflare-limits';
import { logSamplingOf } from '../usage/free-tier';
import { platformAdmin } from './admin';
import {
  type AppEnv,
  authenticate,
  authorize,
  body,
  type Ctx,
  loadSpace,
  spaceRef,
} from './context';
import { id } from './schemas';

// Observability (docs/observability.md): the player's metrics in, the space status page
// and the admin's view of every space out. Writes go to Analytics Engine (metrics/points.ts);
// reads come back through its SQL API (metrics/status.ts).

export const metrics = new Hono<AppEnv>();

const dataset = (c: Ctx): MetricsDataset => metricsDataset(c.env);

const rid = z.string().regex(/^[A-Za-z0-9]{1,16}$/);
const count = (max: number) => z.number().int().min(0).max(max);
const viewerMetrics = z.object({
  roomId: id,
  streamId: id,
  windowMs: z.number().int().min(1_000).max(300_000),
  watchMs: z.number().int().min(0).max(300_000),
  ttffMs: z.number().int().min(0).max(120_000).optional(),
  start: z.enum(['click', 'prepull']),
  layer: rid.optional(),
  freezes: count(100_000),
  fps: z.number().min(0).max(1_000),
  bitrateKbps: z.number().min(0).max(1_000_000),
  lossPct: z.number().min(0).max(100),
  framesDropped: count(10_000_000),
  decodeErrors: count(100_000),
  reconnects: count(100_000),
  rttMs: z.number().min(0).max(60_000).optional(),
  jitterBufferMs: z.number().min(0).max(60_000).optional(),
});

/**
 * Posts per user per minute. A viewer sends one every 30 s per watched stream, plus one when the
 * watch view closes. Counted per isolate, which is enough to stop a runaway client without a D1
 * write per post.
 */
export const VIEWER_POSTS_PER_MINUTE = 10;
const posts = new Map<string, number[]>();

function allowPost(userId: string, now: number): number {
  const recent = (posts.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= VIEWER_POSTS_PER_MINUTE) {
    posts.set(userId, recent);
    return Math.max(1, 60_000 - (now - (recent[0] ?? now)));
  }
  recent.push(now);
  posts.set(userId, recent);
  // Keep the map small: forget users who have not posted for a minute.
  if (posts.size > 10_000) {
    for (const [user, times] of posts) {
      if (!times.some((t) => now - t < 60_000)) posts.delete(user);
    }
  }
  return 0;
}

/** Test hook: start every test with empty counters. */
export function resetViewerRateLimit(): void {
  posts.clear();
}

/** POST /api/metrics/viewer: one watched stream's last ~30 s (docs/PROTOCOL.md 11.3). */
metrics.post('/metrics/viewer', async (c) => {
  const { user } = await authenticate(c);
  const input = await body(c, viewerMetrics);
  const wait = allowPost(user.id, Date.now());
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
  const access = await roomAccess(c.env.DB, input.roomId, user.id);
  if (!access.ok) {
    throw new ApiError(
      access.status,
      access.code,
      access.status === 401 ? undefined : { roomId: input.roomId },
    );
  }
  const spaceId = access.context.room.spaceId;
  noteSpace(c.req.raw, spaceId);
  writeViewer(dataset(c), { spaceId, roomId: input.roomId, streamId: input.streamId }, input);
  return c.body(null, 204);
});

const statusQuery = z.object({ range: z.enum(Object.keys(STATUS_RANGES) as [StatusRange]) });

function rangeOf(c: Ctx): StatusRange {
  const parsed = statusQuery.safeParse({ range: c.req.query('range') ?? '24h' });
  if (!parsed.success) throw new ApiError(400, 'invalid_message', { path: '/range' });
  return parsed.data.range;
}

const config = (c: Ctx) => ({
  token: c.env.CLOUDFLARE_API_TOKEN,
  accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
  logSampling: logSamplingOf(c.env.LOG_SAMPLING_RATE),
});

type Unavailable = Exclude<StatusResult, { available: true }>;
const unavailable = (result: Unavailable) => ({ ...result, available: false as const });

/**
 * GET /api/spaces/:spaceId/status?range=24h|7d: the space's status page, for its owners and
 * admins and the platform admin. `available: false` says why there is nothing to show (no token,
 * a token without Account Analytics: Read, or the API failing) instead of an error.
 */
metrics.get('/spaces/:spaceId/status', async (c) => {
  const { user } = await authenticate(c);
  const range = rangeOf(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.status.view', { space: spaceRef(space) }, { spaceId: space.id });
  c.header('Cache-Control', 'no-store');
  const result = await loadStatus(config(c), range, space.id, false);
  if (!result.available) return c.json({ range, ...unavailable(result) });
  const summary: StatusSummary = result.summaries.get('all') ?? emptySummary();
  return c.json({ range, available: true, summary });
});

/**
 * GET /api/admin/status?range=24h|7d: the same numbers for the whole instance and per space.
 * Spaces with no metrics in the range are left out.
 */
metrics.get('/admin/status', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  const range = rangeOf(c);
  c.header('Cache-Control', 'no-store');
  const [total, bySpace] = await Promise.all([
    loadStatus(config(c), range, null, false),
    loadStatus(config(c), range, null, true),
  ]);
  if (!total.available) return c.json({ range, ...unavailable(total) });
  const ids = bySpace.available
    ? [...bySpace.summaries.keys()].filter((k) => k !== 'instance')
    : [];
  const names = new Map<string, { name: string; slug: string }>();
  if (ids.length > 0) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, slug FROM spaces WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
      .bind(...ids)
      .all<{ id: string; name: string; slug: string }>();
    for (const row of results) names.set(row.id, { name: row.name, slug: row.slug });
  }
  return c.json({
    range,
    available: true,
    summary: total.summaries.get('all') ?? emptySummary(),
    spaces: ids.map((spaceId) => ({
      spaceId,
      // A deleted space keeps its metrics for three months; it shows without a name.
      name: names.get(spaceId)?.name ?? null,
      slug: names.get(spaceId)?.slug ?? null,
      summary: bySpace.available ? bySpace.summaries.get(spaceId) : undefined,
    })),
  });
});

/**
 * GET /api/admin/limits: the "Cloudflare limits" panel. The use of each Workers
 * Free daily limit today (UTC) and over the last 24 hours and, on Workers Paid, the month's use
 * against the included amounts. A figure Cloudflare does not give (no token, a token without the
 * permission, a field the API does not expose) comes back with `used: null`, the reason and
 * Cloudflare's message, never as zero; `debug` holds every query and its raw answer.
 */
metrics.get('/admin/limits', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  c.header('Cache-Control', 'no-store');
  return c.json(await loadLimits(config(c), await workersPlanSetting(c.env.DB)));
});

const workersPlanInput = z.strictObject({ plan: z.enum(WORKERS_PLANS) });

/** PUT /api/admin/workers-plan { plan: detect | free | paid }: the plan the panel assumes (audited). */
metrics.put('/admin/workers-plan', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const { plan } = await body(c, workersPlanInput);
  await saveWorkersPlan(c.env.DB, plan, user.id, Date.now());
  return c.json({ plan });
});
