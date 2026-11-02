// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { z } from 'zod';
import { can } from '../auth/can';
import { auditStatement } from '../db/audit';
import { accessPolicy, platformRoomLimits } from '../db/platform';
import { openRoomIds } from '../db/rooms';
import {
  deleteSpaceStatement,
  getMember,
  insertSpaceStatements,
  listSpacesOf,
  type Space,
  transferStatements,
  updateSpaceStatement,
} from '../db/spaces';
import { isUniqueViolation, newId } from '../db/util';
import { ApiError } from '../errors';
import {
  type AppEnv,
  authorize,
  body,
  type Ctx,
  loadSpace,
  requireUser,
  spaceRef,
  targetOf,
  throttleCreate,
} from './context';
import {
  applyPatch,
  checkCapabilities,
  checkLimits,
  spaceLimits,
  spaceSettingsPatch,
} from './settings';
import { id, name, slug } from './schemas';
import { closeRooms, syncRoomSettings, syncUser } from './sync';

export const spaces = new Hono<AppEnv>();

async function spaceJson(c: Ctx, space: Space, role: string | null) {
  const platform = await platformRoomLimits(c.env.DB);
  return {
    ...space,
    role,
    effectiveSettings: spaceLimits(space.settings, platform),
    // What the space settings may allow.
    platformCapabilities: platform.capabilities,
  };
}

const createSpace = z.strictObject({ name, slug });

/**
 * POST /api/spaces: creates a space; the creator becomes its owner. Who may is the platform
 * setting `spaceCreation`: the platform admin only (default), or anyone signed in.
 */
spaces.post('/spaces', async (c) => {
  const user = await requireUser(c);
  const { spaceCreation: policy } = await accessPolicy(c.env.DB);
  const actor = { userId: user.id, isPlatformAdmin: user.isPlatformAdmin, membership: null };
  if (!can(actor, 'space.create', { policy }).allowed) {
    throw new ApiError(403, 'space_creation_restricted');
  }
  const input = await body(c, createSpace);
  await throttleCreate(c, 'space', user.id);
  const now = Date.now();
  const space = { id: newId('sp'), name: input.name, slug: input.slug, ownerId: user.id };
  try {
    await c.env.DB.batch([
      ...insertSpaceStatements(c.env.DB, space, now),
      auditStatement(
        c.env.DB,
        { spaceId: space.id, actorId: user.id, action: 'space.create', target: space.id },
        now,
      ),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'slug_taken', { slug: input.slug });
    throw err;
  }
  const scope = await loadSpace(c, user, space.id);
  return c.json({ space: await spaceJson(c, scope.space, 'owner') }, 201);
});

/** GET /api/spaces: the caller's spaces. */
spaces.get('/spaces', async (c) => {
  const user = await requireUser(c);
  const list = await listSpacesOf(c.env.DB, user.id);
  const platform = await platformRoomLimits(c.env.DB);
  return c.json({
    spaces: list.map((s) => ({
      ...s,
      effectiveSettings: spaceLimits(s.settings, platform),
      platformCapabilities: platform.capabilities,
    })),
  });
});

spaces.get('/spaces/:spaceId', async (c) => {
  const user = await requireUser(c);
  const { space, actor, member } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.view', { space: spaceRef(space) }, { spaceId: space.id });
  return c.json({ space: await spaceJson(c, space, member?.role ?? null) });
});

const updateSpace = z.strictObject({
  name: name.optional(),
  settings: spaceSettingsPatch.optional(),
});

/** PATCH /api/spaces/:id: name and settings, within the platform ceilings. */
spaces.patch('/spaces/:spaceId', async (c) => {
  const user = await requireUser(c);
  const { space, actor, member } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.settings.update', { space: spaceRef(space) }, { spaceId: space.id });
  const input = await body(c, updateSpace);
  const platform = await platformRoomLimits(c.env.DB);
  checkCapabilities(input.settings?.capabilities, platform.capabilities, '/settings');
  const settings = applyPatch(space.settings, input.settings ?? {});
  checkLimits(settings, platform, '/settings');
  const allowedBefore = spaceLimits(space.settings, platform).capabilities;
  const allowedAfter = spaceLimits(settings, platform).capabilities;
  const capabilitiesChanged = JSON.stringify(allowedBefore) !== JSON.stringify(allowedAfter);
  const now = Date.now();
  await c.env.DB.batch([
    updateSpaceStatement(c.env.DB, space.id, { name: input.name ?? space.name, settings }),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: 'space.update',
        target: space.id,
        data: { ...(input.name ? { name: input.name } : {}), settings: input.settings ?? {} },
      },
      now,
    ),
    ...(capabilitiesChanged
      ? [
          auditStatement(
            c.env.DB,
            {
              spaceId: space.id,
              actorId: user.id,
              action: 'space.capabilities.update',
              target: space.id,
              data: { from: allowedBefore, to: allowedAfter },
            },
            now,
          ),
        ]
      : []),
  ]);
  // The space's open rooms follow its new limits and capabilities at once.
  if (input.settings) await syncRoomSettings(c.env, await openRoomIds(c.env.DB, space.id, now));
  const updated = { ...space, name: input.name ?? space.name, settings };
  return c.json({ space: await spaceJson(c, updated, member?.role ?? null) });
});

/** DELETE /api/spaces/:id: owner only; every open room closes with reason "deleted". */
spaces.delete('/spaces/:spaceId', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  authorize(actor, 'space.delete', { space: spaceRef(space) }, { spaceId: space.id });
  const now = Date.now();
  const rooms = await openRoomIds(c.env.DB, space.id, now);
  await c.env.DB.batch([
    deleteSpaceStatement(c.env.DB, space.id, now),
    auditStatement(
      c.env.DB,
      { spaceId: space.id, actorId: user.id, action: 'space.delete', target: space.id },
      now,
    ),
  ]);
  await closeRooms(c.env, rooms, 'deleted');
  return c.body(null, 204);
});

const transfer = z.strictObject({ userId: id });

/** POST /api/spaces/:id/transfer: the owner hands the space over and becomes an admin. */
spaces.post('/spaces/:spaceId/transfer', async (c) => {
  const user = await requireUser(c);
  const { space, actor } = await loadSpace(c, user, c.req.param('spaceId'));
  const { userId } = await body(c, transfer);
  const target = await getMember(c.env.DB, space.id, userId);
  const present = target !== null && target.bannedAt === null;
  authorize(
    actor,
    'space.transfer',
    { space: spaceRef(space), target: targetOf(userId, present ? target : null) },
    { spaceId: space.id },
  );
  if (!present) throw new ApiError(404, 'member_not_found', { userId });
  const now = Date.now();
  await c.env.DB.batch([
    ...transferStatements(c.env.DB, space.id, user.id, userId),
    auditStatement(
      c.env.DB,
      {
        spaceId: space.id,
        actorId: user.id,
        action: 'space.transfer',
        target: userId,
        data: { from: user.id, previousRole: target.role },
      },
      now,
    ),
  ]);
  await Promise.all([
    syncUser(c.env, space.id, user.id, 'role_changed'),
    syncUser(c.env, space.id, userId, 'role_changed'),
  ]);
  const scope = await loadSpace(c, user, space.id);
  return c.json({ space: await spaceJson(c, scope.space, 'admin') });
});
