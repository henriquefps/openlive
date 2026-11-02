// SPDX-License-Identifier: AGPL-3.0-only
import { Preset } from '@openlive/protocol';
import {
  BUDGET_PRESETS_GB,
  CUSTOM_BUDGET_GB,
  FREE_TIER_GB,
  MAX_PRESET_SEND_KBPS,
} from '@openlive/usage';
import { Hono } from 'hono';
import { z } from 'zod';
import { type Action, can, type ResourceByAction } from '../auth/can';
import { safeEqual } from '../auth/crypto';
import { record, retryAfter } from '../auth/rate-limit';
import { instanceClaimable } from '../auth/signup';
import { auditStatement } from '../db/audit';
import {
  FRAME_RATES,
  platformCapabilities,
  PRESET_CODECS,
  type PlatformSettings,
  platformSettings,
  RESOLUTIONS,
  savePlatformSettings,
  SIGNUP_POLICIES,
  SPACE_CREATION_POLICIES,
} from '../db/platform';
import { allOpenRoomIds, openRoomIds } from '../db/rooms';
import { getSpace } from '../db/spaces';
import { getUser, type User } from '../db/users';
import { ApiError } from '../errors';
import { monthTotalsBySpace } from '../usage/meter';
import { instanceQuota } from '../usage/quota';
import { type AppEnv, body, type Ctx, requireUser } from './context';
import { id } from './schemas';
import { capabilitiesSchema } from '../room/capabilities';
import { closeRooms, syncRoomSettings } from './sync';

// The platform admin: the install-code claim, the month's usage across spaces, the
// platform ceilings and quota choices, and space suspension (accounts: admin-users.ts). The platform admin sees usage
// numbers and space names, never stream content (nothing is recorded).

export const admin = new Hono<AppEnv>();

/** The caller when can() lets them do a platform action, else 403. */
export async function platformAdmin<A extends Action>(
  c: Ctx,
  action: A,
  resource: ResourceByAction[A],
): Promise<User> {
  const user = await requireUser(c);
  const actor = { userId: user.id, isPlatformAdmin: user.isPlatformAdmin, membership: null };
  if (!can(actor, action, resource).allowed) throw new ApiError(403, 'forbidden');
  return user;
}

const CLAIM_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };

const claim = z.strictObject({ code: z.string().min(1).max(256) });

/**
 * POST /api/admin/claim { code }: the platform admin bootstrap. A signed-in
 * user who presents the install code becomes the platform admin, once: only while the instance
 * has none. Without INSTALL_CODE set, nobody can claim.
 */
admin.post('/admin/claim', async (c) => {
  const user = await requireUser(c);
  const installCode = c.env.INSTALL_CODE?.trim();
  if (!installCode) throw new ApiError(403, 'admin_claim_unavailable');
  const input = await body(c, claim);
  const db = c.env.DB;
  const hasAdmin = await db
    .prepare('SELECT 1 FROM users WHERE is_platform_admin = 1 AND deleted_at IS NULL LIMIT 1')
    .first();
  if (hasAdmin) throw new ApiError(409, 'admin_already_claimed');

  const now = Date.now();
  const limit = { bucket: `claim:${user.id}`, ...CLAIM_LIMIT };
  const wait = await retryAfter(db, [limit], now);
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
  if (!(await safeEqual(input.code.trim(), installCode))) {
    await record(db, [limit.bucket], now);
    throw new ApiError(403, 'install_code_invalid');
  }

  // Conditional on there still being no admin, so two concurrent claims cannot both win.
  const update = await db
    .prepare(
      `UPDATE users SET is_platform_admin = 1 WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin = 1 AND deleted_at IS NULL)`,
    )
    .bind(user.id)
    .run();
  if (update.meta.changes === 0) throw new ApiError(409, 'admin_already_claimed');
  await auditStatement(
    db,
    { spaceId: null, actorId: user.id, action: 'platform.admin.claim', target: user.id },
    now,
  ).run();
  return c.json({ user: await getUser(db, user.id) });
});

/** Whether a signed-in user may still claim the instance: an install code is set and no admin. */
export const adminClaimable = (c: Ctx): Promise<boolean> => instanceClaimable(c.env);

/**
 * GET /api/admin/overview: the month so far. The estimate (usage_daily) and the real usage
 * (usage_real_daily, null until the cron has data), the brake state, the cycle, and each space's
 * estimate. Spaces without usage are listed too, so they can be suspended from here.
 */
admin.get('/admin/overview', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  const db = c.env.DB;
  const quota = await instanceQuota(db, new Date());
  const [{ results: spaces }, totals] = await Promise.all([
    db
      .prepare(
        `SELECT s.id, s.name, s.slug, s.created_at, s.suspended_at,
                (SELECT COUNT(*) FROM space_members m
                 WHERE m.space_id = s.id AND m.banned_at IS NULL) AS members
         FROM spaces s WHERE s.deleted_at IS NULL ORDER BY s.created_at`,
      )
      .all<{
        id: string;
        name: string;
        slug: string;
        created_at: number;
        suspended_at: number | null;
        members: number;
      }>(),
    monthTotalsBySpace(db, quota.cycle),
  ]);
  const bySpace = new Map(totals.map((t) => [t.spaceId, t]));
  const { state } = quota;
  return c.json({
    cycle: { ...quota.cycle, daysLeft: quota.daysLeft },
    quota: {
      budget: quota.budget.kind,
      /** The monthly limit in GB, null when unlimited. */
      quotaGB: quota.brakes.quotaGB,
      freeTierGB: FREE_TIER_GB,
      mode: quota.brakes.mode,
      autoEconomy: quota.brakes.autoEconomy,
      level: state.level,
      usedGB: state.usedGB,
      usedFraction: state.usedFraction,
      source: state.source,
      freeTierExceeded: state.freeTierExceeded,
      economyMode: state.economyMode,
      blockNewStreams: state.blockNewStreams,
      cost: state.cost,
      projection: {
        projectedGB: quota.projection.projectedGB,
        cappedAtLimit: quota.projection.cappedAtLimit,
        cost: quota.projection.cost,
      },
    },
    usage: {
      estimatedGB: quota.estimate.egressGB,
      realGB: quota.realGB,
      viewerMinutes: quota.estimate.viewerMinutes,
      streamMinutes: quota.estimate.streamMinutes,
    },
    spaces: spaces.map((s) => {
      const t = bySpace.get(s.id);
      return {
        id: s.id,
        name: s.name,
        slug: s.slug,
        createdAt: s.created_at,
        suspendedAt: s.suspended_at,
        members: s.members,
        estimatedGB: t?.egressGB ?? 0,
        viewerMinutes: t?.viewerMinutes ?? 0,
        streamMinutes: t?.streamMinutes ?? 0,
      };
    }),
  });
});

/** Bounds of the platform ceilings (the highest preset, native, sends about 29.6 Mbps in full). */
export const SETTINGS_BOUNDS = {
  maxBitrateKbps: { min: 1_000, max: MAX_PRESET_SEND_KBPS },
  maxViewersPerStream: { min: 1, max: 50 },
  maxStreamsPerRoom: { min: 1, max: 20 },
  // 0 turns cameras off in practice; each camera is pulled by everyone else in voice.
  maxCamerasPerRoom: { min: 0, max: 12 },
} as const;

const int = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

const settingsInput = z.strictObject({
  maxResolution: z.enum(RESOLUTIONS),
  maxFps: z.union(FRAME_RATES.map((f) => z.literal(f))),
  maxBitrateKbps: int(SETTINGS_BOUNDS.maxBitrateKbps),
  maxViewersPerStream: int(SETTINGS_BOUNDS.maxViewersPerStream),
  maxStreamsPerRoom: int(SETTINGS_BOUNDS.maxStreamsPerRoom),
  // Optional so that a client from before cameras keeps the current value.
  maxCamerasPerRoom: int(SETTINGS_BOUNDS.maxCamerasPerRoom).optional(),
  budget: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('free') }),
    z.strictObject({
      kind: z.literal('preset'),
      limitGB: z.union(BUDGET_PRESETS_GB.map((gb) => z.literal(gb))),
    }),
    z.strictObject({
      kind: z.literal('custom'),
      limitGB: z.number().int().min(CUSTOM_BUDGET_GB.min).max(CUSTOM_BUDGET_GB.max),
    }),
    z.strictObject({ kind: z.literal('unlimited') }),
  ]),
  quotaMode: z.enum(['block', 'alerts_only']),
  autoEconomy: z.boolean(),
  backgroundPause: z.boolean(),
  idleCheck: z.boolean(),
  cycleResetDay: z.number().int().min(1).max(31),
  overheads: z.boolean(),
  signup: z.enum(SIGNUP_POLICIES),
  spaceCreation: z.enum(SPACE_CREATION_POLICIES),
  // Optional so that a client from before capabilities keeps the current ones.
  capabilities: capabilitiesSchema.optional(),
  // Optional so that a client from before AV1 keeps the current choice.
  allowAv1: z.boolean().optional(),
  // `auto`, from a client before AV1 modes, is `av1Save`.
  presetCodecs: z
    .partialRecord(
      z.enum(Preset),
      z.enum([...PRESET_CODECS, 'auto']).transform((c) => (c === 'auto' ? 'av1Save' : c)),
    )
    .optional(),
}) satisfies z.ZodType<
  Omit<PlatformSettings, 'capabilities' | 'maxCamerasPerRoom' | 'allowAv1' | 'presetCodecs'> & {
    capabilities?: PlatformSettings['capabilities'] | undefined;
    maxCamerasPerRoom?: number | undefined;
    allowAv1?: boolean | undefined;
    presetCodecs?: PlatformSettings['presetCodecs'] | undefined;
  }
>;

/** GET /api/admin/settings: the platform ceilings and quota choices (defaults when unset). */
admin.get('/admin/settings', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  return c.json({ settings: await platformSettings(c.env.DB) });
});

/**
 * PUT /api/admin/settings { ...PlatformSettings }: replaces them (audited). Lower ceilings apply
 * at once to every space and room, which only ever reduce them.
 */
admin.put('/admin/settings', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const input = await body(c, settingsInput);
  const capabilities = input.capabilities ?? (await platformCapabilities(c.env.DB));
  const before = await platformSettings(c.env.DB);
  const camerasBefore = before.maxCamerasPerRoom;
  const maxCamerasPerRoom = input.maxCamerasPerRoom ?? camerasBefore;
  const allowAv1 = input.allowAv1 ?? before.allowAv1;
  const presetCodecs = input.presetCodecs ?? before.presetCodecs;
  const now = Date.now();
  const saved = await savePlatformSettings(
    c.env.DB,
    { ...input, capabilities, maxCamerasPerRoom, allowAv1, presetCodecs },
    user.id,
    now,
  );
  // Rooms that lost a capability follow at once (a live stream ends when stream is turned off).
  // A lower camera limit too: cameras above it are turned off (PROTOCOL.md 7.7).
  if (saved.capabilitiesChanged || maxCamerasPerRoom < camerasBefore)
    await syncRoomSettings(c.env, await allOpenRoomIds(c.env.DB, now));
  return c.json({ settings: await platformSettings(c.env.DB) });
});

async function setSuspended(c: Ctx, suspend: boolean) {
  const spaceId = c.req.param('spaceId') ?? '';
  const space = id.safeParse(spaceId).success ? await getSpace(c.env.DB, spaceId) : null;
  // can() first, so a non-admin cannot probe which space ids exist.
  const user = await platformAdmin(c, 'platform.space.suspend', {
    space: { id: spaceId, settings: { membersCanInviteGuests: true } },
  });
  if (!space) throw new ApiError(404, 'space_not_found', { spaceId });
  // Idempotent: suspending a suspended space (or lifting a lifted one) changes and audits nothing.
  if ((space.suspendedAt !== null) === suspend) {
    return c.json({ space: { id: space.id, suspendedAt: space.suspendedAt } });
  }
  const now = Date.now();
  const db = c.env.DB;
  const rooms = suspend ? await openRoomIds(db, space.id, now) : [];
  const suspendedAt = suspend ? now : null;
  await db.batch([
    db.prepare('UPDATE spaces SET suspended_at = ? WHERE id = ?').bind(suspendedAt, space.id),
    auditStatement(
      db,
      {
        spaceId: space.id,
        actorId: user.id,
        action: suspend ? 'platform.space.suspend' : 'platform.space.unsuspend',
        target: space.id,
      },
      now,
    ),
  ]);
  await closeRooms(c.env, rooms, 'suspended');
  return c.json({ space: { id: space.id, suspendedAt } });
}

/** POST /api/admin/spaces/:spaceId/suspend: closes its rooms and keeps everyone out (audited). */
admin.post('/admin/spaces/:spaceId/suspend', (c) => setSuspended(c, true));

/** POST /api/admin/spaces/:spaceId/unsuspend: lifts the suspension (audited). */
admin.post('/admin/spaces/:spaceId/unsuspend', (c) => setSuspended(c, false));
