// SPDX-License-Identifier: AGPL-3.0-only
// The admin onboarding wizard's progress and each user's tutorial progress.
// The wizard is instance-wide, so it lives in platform_settings (key `onboarding`); the tutorial
// is per user (user_tutorial, migration 0006).

/** platform_settings key holding the wizard's progress. */
export const ONBOARDING_KEY = 'onboarding';

/**
 * The wizard's steps: account, checks, quality, calculator, quota, access (who may
 * sign up and create spaces), first space.
 */
export const ONBOARDING_STEPS = 7;

export interface Onboarding {
  /** The step to resume at, 1–7. */
  step: number;
  completedAt: number | null;
  skippedAt: number | null;
}

const EMPTY: Onboarding = { step: 1, completedAt: null, skippedAt: null };

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export async function getOnboarding(db: D1Database): Promise<Onboarding> {
  const row = await db
    .prepare('SELECT value_json FROM platform_settings WHERE key = ?')
    .bind(ONBOARDING_KEY)
    .first<{ value_json: string }>();
  if (!row) return EMPTY;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    value = parsed as Record<string, unknown>;
  } catch {
    return EMPTY;
  }
  const step = value['step'];
  return {
    step:
      typeof step === 'number' && Number.isInteger(step) && step >= 1 && step <= ONBOARDING_STEPS
        ? step
        : 1,
    completedAt: isTime(value['completedAt']) ? value['completedAt'] : null,
    skippedAt: isTime(value['skippedAt']) ? value['skippedAt'] : null,
  };
}

export async function saveOnboarding(
  db: D1Database,
  value: Onboarding,
  actorId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO platform_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(ONBOARDING_KEY, JSON.stringify(value), actorId, now)
    .run();
}

export interface Tutorial {
  /** Screen ids whose tutorial ran (finished or skipped). */
  seen: string[];
  /** "Don't show tutorials again". */
  disabled: boolean;
}

export async function getTutorial(db: D1Database, userId: string): Promise<Tutorial> {
  const row = await db
    .prepare('SELECT seen_json, disabled FROM user_tutorial WHERE user_id = ?')
    .bind(userId)
    .first<{ seen_json: string; disabled: number }>();
  if (!row) return { seen: [], disabled: false };
  let seen: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.seen_json);
    if (Array.isArray(parsed)) seen = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // A corrupt row reads as nothing seen; the next PUT replaces it.
  }
  return { seen, disabled: row.disabled === 1 };
}

export async function saveTutorial(
  db: D1Database,
  userId: string,
  value: Tutorial,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_tutorial (user_id, seen_json, disabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET seen_json = excluded.seen_json,
         disabled = excluded.disabled, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify([...new Set(value.seen)]), value.disabled ? 1 : 0, now)
    .run();
}
