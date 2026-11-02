// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { clearSessionCookie } from '../auth/cookies';
import { appOrigin } from '../auth/origin';
import { can } from '../auth/can';
import { isAppTokenId, listAppTokens } from '../auth/app-tokens';
import { listSessions, revokeSession } from '../auth/session';
import { platformSettings } from '../db/platform';
import { avatarState } from '../db/avatars';
import { listSpacesOf } from '../db/spaces';
import { getUser } from '../db/users';
import { ApiError } from '../errors';
import { instanceQuota } from '../usage/quota';
import { adminClaimable } from './admin';
import { revokeAppAndClose } from './app';
import { type AppEnv, authenticate, body, requireUser } from './context';
import { id, name } from './schemas';

export const me = new Hono<AppEnv>();

/**
 * GET /api/me: the caller, the spaces they belong to, whether they may claim the instance (no
 * platform admin yet) or create a space, and the instance's quota state as codes, so every user sees the 70/90/100 %
 * warnings of the monthly limit and the free-tier notice. Usage
 * numbers stay in the admin overview; the platform admin also gets the cost so far.
 */
me.get('/me', async (c) => {
  const user = await requireUser(c);
  const settings = await platformSettings(c.env.DB);
  const [spaces, avatar, claimable, { state, brakes }] = await Promise.all([
    listSpacesOf(c.env.DB, user.id),
    avatarState(c.env.DB, user.id),
    user.isPlatformAdmin ? false : adminClaimable(c),
    instanceQuota(c.env.DB, new Date(), settings),
  ]);
  const actor = { userId: user.id, isPlatformAdmin: user.isPlatformAdmin, membership: null };
  return c.json({
    user,
    /** Where the profile photo comes from, for Settings -> Profile (src/api/avatars.ts). */
    avatar,
    memberships: spaces.map((s) => ({
      spaceId: s.id,
      name: s.name,
      slug: s.slug,
      role: s.role,
      suspended: s.suspendedAt !== null,
    })),
    adminClaimable: claimable,
    /** Whether "Create space" works for the caller (platform setting `spaceCreation`). */
    canCreateSpace: can(actor, 'space.create', { policy: settings.spaceCreation }).allowed,
    quota: {
      level: state.level,
      /** The monthly limit the levels are relative to (a setting, not usage); null when unlimited. */
      limitGB: brakes.quotaGB,
      mode: brakes.mode,
      freeTierExceeded: state.freeTierExceeded,
      economyMode: state.economyMode,
      blockNewStreams: state.blockNewStreams,
      // The cost so far is a usage number: only the platform admin gets it.
      ...(user.isPlatformAdmin ? { costUsd: state.cost.usd } : {}),
    },
    /** The viewer brakes 5 and 6: settings the player applies, on by default. */
    viewerBrakes: { backgroundPause: settings.backgroundPause, idleCheck: settings.idleCheck },
  });
});

const updateMe = z.strictObject({
  displayName: name.optional(),
  /** The saved interface language; null goes back to the browser's language. */
  locale: z.enum(['en', 'pt-BR']).nullable().optional(),
});

/** PUT /api/me { displayName?, locale? }: the caller's profile. */
me.put('/me', async (c) => {
  const user = await requireUser(c);
  const input = await body(c, updateMe);
  await c.env.DB.prepare(
    `UPDATE users SET display_name = coalesce(?, display_name),
       locale = CASE WHEN ? THEN ? ELSE locale END
     WHERE id = ?`,
  )
    .bind(
      input.displayName ?? null,
      input.locale !== undefined ? 1 : 0,
      input.locale ?? null,
      user.id,
    )
    .run();
  return c.json({ user: await getUser(c.env.DB, user.id) });
});

/**
 * GET /api/me/sessions: the caller's signed-in browsers (`kind: 'browser'`) and mobile apps
 * (`kind: 'app'`, one per app token), newest first.
 */
me.get('/me/sessions', async (c) => {
  const { user, sessionId, appTokenId } = await authenticate(c);
  const [browsers, apps] = await Promise.all([
    listSessions(c.env.DB, user.id),
    listAppTokens(c.env.DB, user.id, Date.now()),
  ]);
  const sessions = [
    ...browsers.map((s) => ({ ...s, kind: 'browser' as const, current: s.id === sessionId })),
    ...apps.map((a) => ({
      id: a.id,
      kind: 'app' as const,
      createdAt: a.createdAt,
      deviceName: a.deviceName,
      lastUsedAt: a.lastUsedAt,
      current: a.id === appTokenId,
    })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  return c.json({ sessions });
});

/** DELETE /api/me/sessions/:sessionId: signs one of the caller's sessions (or apps) out. */
me.delete('/me/sessions/:sessionId', async (c) => {
  const { user, sessionId: current } = await authenticate(c);
  const sessionId = c.req.param('sessionId');
  // An app's session is its app token: revoking it also closes the app's sockets.
  const revoked =
    id.safeParse(sessionId).success &&
    (isAppTokenId(sessionId)
      ? await revokeAppAndClose(c.env, user.id, sessionId)
      : await revokeSession(c.env.DB, user.id, sessionId));
  if (!revoked) {
    throw new ApiError(
      404,
      'session_not_found',
      id.safeParse(sessionId).success ? { sessionId } : {},
    );
  }
  if (sessionId === current) {
    const origin = appOrigin(c.req.raw, c.env);
    if (origin) clearSessionCookie(c, origin);
  }
  return c.body(null, 204);
});
