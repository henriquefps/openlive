// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import {
  getOnboarding,
  getTutorial,
  ONBOARDING_STEPS,
  saveOnboarding,
  saveTutorial,
} from '../db/onboarding';
import { platformAdmin } from './admin';
import { runChecks } from './checks';
import { type AppEnv, body, requireUser } from './context';

// The admin onboarding wizard and the per-user interactive tutorial.

export const onboarding = new Hono<AppEnv>();

/** GET /api/admin/checks: each secret and binding as ok | missing | error plus a code. */
onboarding.get('/admin/checks', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  return c.json({ checks: await runChecks(c.env) });
});

/** GET /api/admin/onboarding: the step to resume at, and whether it was completed or skipped. */
onboarding.get('/admin/onboarding', async (c) => {
  await platformAdmin(c, 'platform.usage.view', {});
  return c.json({ onboarding: await getOnboarding(c.env.DB) });
});

const onboardingInput = z.strictObject({
  step: z.number().int().min(1).max(ONBOARDING_STEPS),
  /**
   * `in_progress` saves the step, `skipped` is "Skip for now", `completed` finishes the wizard.
   * A skip is kept until completion: /admin then shows a reminder instead of opening the wizard.
   * Completing is final; later calls only move the step.
   */
  state: z.enum(['in_progress', 'skipped', 'completed']),
});

/** PUT /api/admin/onboarding { step, state }: saves the wizard's progress. */
onboarding.put('/admin/onboarding', async (c) => {
  const user = await platformAdmin(c, 'platform.settings.update', {});
  const input = await body(c, onboardingInput);
  const now = Date.now();
  const current = await getOnboarding(c.env.DB);
  const completedAt = current.completedAt ?? (input.state === 'completed' ? now : null);
  const next = {
    step: input.step,
    completedAt,
    skippedAt:
      completedAt !== null ? null : (current.skippedAt ?? (input.state === 'skipped' ? now : null)),
  };
  await saveOnboarding(c.env.DB, next, user.id, now);
  return c.json({ onboarding: next });
});

/** GET /api/me/tutorial: the screens whose tutorial the caller has seen, and the global off switch. */
onboarding.get('/me/tutorial', async (c) => {
  const user = await requireUser(c);
  return c.json({ tutorial: await getTutorial(c.env.DB, user.id) });
});

/** Screen ids as the web registers them (`spaces`, `space`, `room`, `topbar`, later `player`). */
const screenId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const tutorialInput = z.strictObject({
  seen: z.array(screenId).max(64),
  disabled: z.boolean(),
});

/** PUT /api/me/tutorial { seen, disabled }: replaces it. `{ seen: [], disabled: false }` replays. */
onboarding.put('/me/tutorial', async (c) => {
  const user = await requireUser(c);
  const input = await body(c, tutorialInput);
  await saveTutorial(c.env.DB, user.id, input, Date.now());
  return c.json({ tutorial: await getTutorial(c.env.DB, user.id) });
});
