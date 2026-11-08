// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { auditStatement } from '../db/audit';
import { rawEnv } from '../usage/brake-guard';
import {
  alertLevels,
  BRAKE_PERCENT_MAX,
  BRAKE_PERCENT_MIN,
  BRAKE_SETTING_KEY,
  BRAKE_STATE_KEY,
  type BrakeSetting,
  type BrakeState,
  engagedByHand,
  forgetBrakeState,
  isEngaged,
  PAID_USD_PER_DAY_MAX,
  putSetting,
  readBrakeRows,
  releasedState,
} from '../usage/limits-brake';
import { sleepLiveObjects } from '../usage/limits-monitor';
import { platformAdmin } from './admin';
import { type AppEnv, body, type Ctx } from './context';

// The limits brake in the admin panel: the monitor's last snapshot, the setting,
// the state, and the release / engage buttons. None of these routes touches a Durable Object
// (D1 only), so they work while the brake holds; engaging by hand puts the live objects to sleep
// with the runtime's bindings, after the answer.

export const limitsBrake = new Hono<AppEnv>();

async function view(c: Ctx, now: number) {
  const rows = await readBrakeRows(c.env.DB);
  const engaged = isEngaged(rows.state, now) ? rows.state.engaged : null;
  return {
    setting: rows.setting,
    state: {
      engaged,
      releasedUntil:
        rows.state.releasedUntil !== null && now < rows.state.releasedUntil
          ? rows.state.releasedUntil
          : null,
    },
    snapshot: rows.snapshot,
    alertLevels: alertLevels(rows.setting),
    alertsSentToday:
      rows.alerts.day === new Date(now).toISOString().slice(0, 10) ? rows.alerts.sent : [],
    bounds: {
      percentMin: BRAKE_PERCENT_MIN,
      percentMax: BRAKE_PERCENT_MAX,
      usdPerDayMax: PAID_USD_PER_DAY_MAX,
    },
    now,
  };
}

/** GET /api/admin/limits/brake: the stored snapshot (no Cloudflare query), setting and state. */
limitsBrake.get('/admin/limits/brake', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  c.header('Cache-Control', 'no-store');
  return c.json(await view(c, Date.now()));
});

const settingInput = z.strictObject({
  enabled: z.boolean(),
  percent: z.number().int().min(BRAKE_PERCENT_MIN).max(BRAKE_PERCENT_MAX),
  paid: z.strictObject({
    includedShare: z.boolean(),
    usdPerDay: z.number().positive().max(PAID_USD_PER_DAY_MAX).nullable(),
  }),
});

/**
 * PUT /api/admin/limits/brake: the brake's percent, its Paid budget and the off switch (audited).
 * Turning it off also releases an engagement.
 */
limitsBrake.put('/admin/limits/brake', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const setting: BrakeSetting = await body(c, settingInput);
  const now = Date.now();
  const before = await readBrakeRows(c.env.DB);
  const release = !setting.enabled && isEngaged(before.state, now);
  const state = release ? releasedState(now) : null;
  await c.env.DB.batch([
    putSetting(c.env.DB, BRAKE_SETTING_KEY, setting, user.id, now),
    ...(state ? [putSetting(c.env.DB, BRAKE_STATE_KEY, state, user.id, now)] : []),
    auditStatement(
      c.env.DB,
      {
        spaceId: null,
        actorId: user.id,
        action: 'platform.limits_brake.update',
        target: null,
        data: { from: before.setting, to: setting, released: release },
      },
      now,
    ),
  ]);
  if (state) forgetBrakeState(state, now);
  return c.json(await view(c, now));
});

async function saveState(c: Ctx, state: BrakeState, action: string, actorId: string, now: number) {
  await c.env.DB.batch([
    putSetting(c.env.DB, BRAKE_STATE_KEY, state, actorId, now),
    auditStatement(
      c.env.DB,
      { spaceId: null, actorId, action, target: null, data: { state } },
      now,
    ),
  ]);
  // This isolate follows at once; others within BRAKE_CACHE_MS (30 s).
  forgetBrakeState(state, now);
}

/** POST /api/admin/limits/brake/release: released until the next 00:00 UTC (audited). */
limitsBrake.post('/admin/limits/brake/release', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const now = Date.now();
  await saveState(c, releasedState(now), 'platform.limits_brake.release', user.id, now);
  return c.json(await view(c, now));
});

/**
 * POST /api/admin/limits/brake/engage: engaged by hand until the next 00:00 UTC or a release
 * (audited). The live objects are told to sleep after the answer.
 */
limitsBrake.post('/admin/limits/brake/engage', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const now = Date.now();
  const state = engagedByHand(now);
  await saveState(c, state, 'platform.limits_brake.engage', user.id, now);
  const env = rawEnv(c.env);
  const until = state.engaged?.until ?? now;
  c.executionCtx.waitUntil(
    sleepLiveObjects(env, until, now).catch((error: unknown) => {
      console.warn('limits brake: sleeping the live objects failed', error);
    }),
  );
  return c.json(await view(c, now));
});
