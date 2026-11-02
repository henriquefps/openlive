// SPDX-License-Identifier: AGPL-3.0-only
import { billingCycle, cycleElapsedFraction, presetSendKbps } from '@openlive/usage';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { SETTINGS_BOUNDS } from '../src/api/admin';
import { DEV_USER_HEADER } from '../src/room/identity';
import { auditRows, call, fixedRoom, migrate, newUser, setAccess, world } from './api-helpers';
import { Client, upgrade } from './room-helpers';

// The platform admin API: overview, settings, suspension, and what
// /api/me tells every user about the quota. Usage and settings are instance-wide, so each test
// starts from empty usage tables and default settings.

beforeAll(migrate);
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_daily'),
    env.DB.prepare('DELETE FROM usage_real_daily'),
    env.DB.prepare('DELETE FROM platform_settings'),
  ]);
  // world() creates its space as a regular user.
  await setAccess({ signup: 'open', spaceCreation: 'members' });
});

const today = () => new Date().toISOString().slice(0, 10);

async function estimate(spaceId: string, gb: number, day = today()) {
  await env.DB.prepare(
    `INSERT INTO usage_daily (space_id, day, egress_gb_est, viewer_minutes, stream_minutes)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(spaceId, day, gb, 60, 30)
    .run();
}

async function real(gb: number, day = today()) {
  await env.DB.prepare(
    `INSERT INTO usage_real_daily (day, service, resource_id, egress_bytes, fetched_at)
     VALUES (?, 'sfu', 'app', ?, ?)`,
  )
    .bind(day, gb * 1e9, Date.now())
    .run();
}

const DEFAULTS = {
  maxResolution: '1440p',
  maxFps: 60,
  maxBitrateKbps: 13_000,
  maxViewersPerStream: 6,
  maxStreamsPerRoom: 5,
  maxCamerasPerRoom: 6,
  budget: { kind: 'free' },
  quotaMode: 'block',
  autoEconomy: true,
  backgroundPause: true,
  idleCheck: true,
  cycleResetDay: 1,
  overheads: true,
  signup: 'invite_only',
  spaceCreation: 'admin_only',
  capabilities: { stream: true, voice: true, camera: true, text: true },
  allowAv1: false,
  presetCodecs: {},
};

describe('who may use the admin API', () => {
  it('answers 401 to anonymous callers and 403 to everyone but the platform admin', async () => {
    const w = await world();
    const routes: [string, string, unknown?][] = [
      ['GET', '/admin/overview'],
      ['GET', '/admin/settings'],
      ['PUT', '/admin/settings', DEFAULTS],
      ['POST', `/admin/spaces/${w.spaceId}/suspend`],
      ['POST', `/admin/spaces/${w.spaceId}/unsuspend`],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(method, path, undefined, body)).status).toBe(401);
      // The space owner is not a platform admin.
      expect(await call(method, path, w.owner, body)).toEqual({
        status: 403,
        body: { code: 'forbidden' },
      });
    }
  });

  it('does not reveal whether a space id exists to a non-admin', async () => {
    const user = await newUser('nosy');
    expect((await call('POST', '/admin/spaces/s_unknown/suspend', user)).status).toBe(403);
  });
});

describe('GET /api/admin/overview', () => {
  it('sums the estimate and the real usage over the cycle, per space too', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const a = await world();
    const b = await world();
    await estimate(a.spaceId, 300);
    await estimate(b.spaceId, 112);
    await estimate(a.spaceId, 999, '2000-01-01'); // outside the cycle
    await real(450);

    const res = await call('GET', '/admin/overview', admin);
    expect(res.status).toBe(200);
    const cycle = billingCycle(new Date(), 1);
    expect(res.body.cycle).toMatchObject(cycle);
    expect(res.body.cycle.daysLeft).toBeGreaterThanOrEqual(1);
    expect(res.body.cycle.daysLeft).toBeLessThanOrEqual(31);
    expect(res.body.usage).toMatchObject({ realGB: 450, viewerMinutes: 120, streamMinutes: 60 });
    expect(res.body.usage.estimatedGB).toBeCloseTo(412, 9);
    // The brakes act on the larger of the two.
    expect(res.body.quota).toMatchObject({
      budget: 'free',
      quotaGB: 1000,
      freeTierGB: 1000,
      mode: 'block',
      freeTierExceeded: false,
      level: 'ok',
      usedGB: 450,
      source: 'real',
      economyMode: false,
      blockNewStreams: false,
      cost: { gbAboveFree: 0, usd: 0 },
    });
    const spaces = new Map(res.body.spaces.map((s: { id: string }) => [s.id, s]));
    expect(spaces.get(a.spaceId)).toMatchObject({
      name: 'Friends',
      suspendedAt: null,
      members: 5,
      estimatedGB: 300,
      viewerMinutes: 60,
    });
    expect(spaces.get(b.spaceId)).toMatchObject({ estimatedGB: 112 });
  });

  it('reports no real usage as null, and the cost above the free tier', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await estimate(w.spaceId, 1_100);
    const res = await call('GET', '/admin/overview', admin);
    expect(res.body.usage.realGB).toBeNull();
    expect(res.body.quota).toMatchObject({
      level: 'warn_100',
      source: 'estimate',
      blockNewStreams: true,
      economyMode: true,
    });
    expect(res.body.quota.cost.gbAboveFree).toBeCloseTo(100, 9);
    expect(res.body.quota.cost.usd).toBeCloseTo(5, 9);
  });

  it('follows the cycle reset day and the quota mode from the settings', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await estimate(w.spaceId, 980);
    const put = await call('PUT', '/admin/settings', admin, {
      ...DEFAULTS,
      quotaMode: 'alerts_only',
      cycleResetDay: 31,
    });
    expect(put.status).toBe(200);
    const res = await call('GET', '/admin/overview', admin);
    expect(res.body.cycle).toMatchObject(billingCycle(new Date(), 31));
    expect(res.body.quota).toMatchObject({
      mode: 'alerts_only',
      level: 'warn_90',
      blockNewStreams: false,
    });
  });
});

describe('monthly limit', () => {
  it.each([
    // budget, mode, GB used → level, free tier exceeded, economy, block
    [{ kind: 'free' }, 'block', 960, 'warn_90', false, true, true],
    [{ kind: 'preset', limitGB: 1500 }, 'block', 1_100, 'warn_70', true, false, false],
    [{ kind: 'preset', limitGB: 2000 }, 'block', 1_950, 'warn_90', true, true, true],
    [{ kind: 'preset', limitGB: 5000 }, 'alerts_only', 6_000, 'warn_100', true, true, false],
    [{ kind: 'custom', limitGB: 400 }, 'block', 390, 'warn_90', false, true, true],
    [{ kind: 'unlimited' }, 'block', 9_000, 'ok', true, false, false],
  ] as const)(
    '%o in %s mode at %d GB → %s',
    async (budget, quotaMode, gb, level, freeTierExceeded, economyMode, blockNewStreams) => {
      const admin = await newUser('admin', { platformAdmin: true });
      const w = await world();
      await call('PUT', '/admin/settings', admin, { ...DEFAULTS, budget, quotaMode });
      await estimate(w.spaceId, gb);
      const res = await call('GET', '/admin/overview', admin);
      expect(res.body.quota).toMatchObject({
        budget: budget.kind,
        quotaGB: 'limitGB' in budget ? budget.limitGB : budget.kind === 'free' ? 1000 : null,
        level,
        freeTierExceeded,
        economyMode,
        blockNewStreams,
      });
    },
  );

  it('never enters economy mode when the admin turned it off', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await call('PUT', '/admin/settings', admin, { ...DEFAULTS, autoEconomy: false });
    await estimate(w.spaceId, 960);
    const res = await call('GET', '/admin/overview', admin);
    expect(res.body.quota).toMatchObject({ economyMode: false, blockNewStreams: true });
  });

  it('projects the cycle linearly and stops at the limit in block mode', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await call('PUT', '/admin/settings', admin, {
      ...DEFAULTS,
      budget: { kind: 'unlimited' },
    });
    await estimate(w.spaceId, 412);
    const now = new Date();
    const fraction = cycleElapsedFraction(now, billingCycle(now, 1));
    const res = await call('GET', '/admin/overview', admin);
    // A few ms pass between the two clocks.
    expect(res.body.quota.projection.projectedGB).toBeCloseTo(412 / fraction, 0);
    expect(res.body.quota.projection.cappedAtLimit).toBe(false);

    await call('PUT', '/admin/settings', admin, {
      ...DEFAULTS,
      budget: { kind: 'custom', limitGB: 412 },
    });
    const capped = await call('GET', '/admin/overview', admin);
    // Already at the limit with time left in the cycle: the projection stops at the limit.
    expect(capped.body.quota.projection).toMatchObject({
      projectedGB: 412,
      cappedAtLimit: true,
      cost: { gbAboveFree: 0, usd: 0 },
    });
  });

  it('reads the settings stored under the old `quota` key until the next save', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_by, updated_at)
       VALUES ('quota', ?, NULL, 0)`,
    )
      .bind(JSON.stringify({ mode: 'alerts_only', cycleResetDay: 17, overheads: false }))
      .run();
    const before = await call('GET', '/admin/settings', admin);
    expect(before.body.settings).toMatchObject({
      budget: { kind: 'free' },
      quotaMode: 'alerts_only',
      autoEconomy: true,
      cycleResetDay: 17,
      overheads: false,
    });

    await call('PUT', '/admin/settings', admin, {
      ...before.body.settings,
      budget: { kind: 'preset', limitGB: 2000 },
    });
    const keys = await env.DB.prepare('SELECT key, value_json FROM platform_settings').all<{
      key: string;
      value_json: string;
    }>();
    const byKey = new Map(keys.results.map((r) => [r.key, JSON.parse(r.value_json)]));
    expect(byKey.has('quota')).toBe(false);
    expect(byKey.get('budget')).toEqual({
      budget: { kind: 'preset', limitGB: 2000 },
      mode: 'alerts_only',
      autoEconomy: true,
      backgroundPause: true,
      idleCheck: true,
      cycleResetDay: 17,
      overheads: false,
    });
  });
});

describe('platform settings', () => {
  it('GET returns the defaults until the admin saves something', async () => {
    await setAccess(null);
    const admin = await newUser('admin', { platformAdmin: true });
    expect(await call('GET', '/admin/settings', admin)).toEqual({
      status: 200,
      body: { settings: DEFAULTS },
    });
  });

  it('PUT saves them, audited, and spaces get the new ceilings at once', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const next = {
      ...DEFAULTS,
      maxResolution: '1080p',
      maxBitrateKbps: 8_000,
      maxViewersPerStream: 4,
      maxStreamsPerRoom: 2,
      overheads: false,
    };
    const res = await call('PUT', '/admin/settings', admin, next);
    expect(res).toEqual({ status: 200, body: { settings: next } });
    expect(await call('GET', '/admin/settings', admin)).toEqual({
      status: 200,
      body: { settings: next },
    });

    const space = await call('GET', `/spaces/${w.spaceId}`, w.owner);
    expect(space.body.space.effectiveSettings).toEqual({
      maxStreams: 2,
      maxViewersPerStream: 4,
      maxBitrateKbps: 8_000,
      // 1080p60: text and game, not max (1440p60).
      allowedPresets: ['text', 'game'],
      capabilities: { stream: true, voice: true, camera: true, text: true },
      maxVoiceParticipants: 12,
      guestsCanSpeak: true,
      maxCameras: 6,
      guestsCanUseCamera: false,
      chatRetentionDays: 90,
      guestsCanWrite: true,
    });
    const audit = await env.DB.prepare(
      "SELECT actor_id, data_json FROM audit_log WHERE action = 'platform.settings.update' AND actor_id = ?",
    )
      .bind(admin)
      .first<{ actor_id: string; data_json: string }>();
    expect(JSON.parse(audit?.data_json ?? '{}')).toEqual(next);
  });

  it('derives the allowed presets from the resolution and fps ceiling', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const cases: [string, number, string[]][] = [
      ['2160p', 60, ['text', 'game', 'max', 'native']],
      ['1440p', 60, ['text', 'game', 'max']],
      ['2160p', 30, ['text']],
      // The 120 fps presets only with a 120 fps ceiling, max120 from 1440p.
      ['1440p', 120, ['text', 'game', 'max', 'game120', 'max120']],
      ['1080p', 120, ['text', 'game', 'game120']],
      ['2160p', 120, ['text', 'game', 'max', 'native', 'game120', 'max120']],
    ];
    for (const [maxResolution, maxFps, presets] of cases) {
      await call('PUT', '/admin/settings', admin, { ...DEFAULTS, maxResolution, maxFps });
      const space = await call('GET', `/spaces/${w.spaceId}`, w.owner);
      expect(space.body.space.effectiveSettings.allowedPresets).toEqual(presets);
    }
  });

  it('allows AV1 for the presets on Automatic; rooms get them as av1Presets', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const space = async () =>
      (await call('GET', `/spaces/${w.spaceId}`, w.owner)).body.space.effectiveSettings;
    expect((await space()).av1Presets).toBeUndefined();
    const next = { ...DEFAULTS, allowAv1: true, presetCodecs: { max: 'h264' } };
    expect(await call('PUT', '/admin/settings', admin, next)).toEqual({
      status: 200,
      body: { settings: next },
    });
    expect((await space()).av1Presets).toEqual(['text', 'game']);
    // A client from before AV1 keeps the choice.
    const old = Object.fromEntries(
      Object.entries(next).filter(([key]) => key !== 'allowAv1' && key !== 'presetCodecs'),
    );
    await call('PUT', '/admin/settings', admin, { ...old, maxStreamsPerRoom: 3 });
    expect((await call('GET', '/admin/settings', admin)).body.settings).toMatchObject({
      allowAv1: true,
      presetCodecs: { max: 'h264' },
    });
    expect(
      (await call('PUT', '/admin/settings', admin, { ...next, presetCodecs: { game: 'vp9' } }))
        .status,
    ).toBe(400);
    await call('PUT', '/admin/settings', admin, DEFAULTS);
    expect((await space()).av1Presets).toBeUndefined();
  });

  it('sets each preset to AV1 save data, AV1 quality or H.264 only; rooms get the quality ones', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const space = async () =>
      (await call('GET', `/spaces/${w.spaceId}`, w.owner)).body.space.effectiveSettings;
    const next = {
      ...DEFAULTS,
      allowAv1: true,
      presetCodecs: { text: 'av1Save', game: 'av1Quality', max: 'h264' },
    };
    expect(await call('PUT', '/admin/settings', admin, next)).toEqual({
      status: 200,
      body: { settings: next },
    });
    expect(await space()).toMatchObject({
      av1Presets: ['text', 'game'],
      av1QualityPresets: ['game'],
    });
    // A client from before AV1 modes sends `auto`: it is saving data.
    await call('PUT', '/admin/settings', admin, { ...next, presetCodecs: { game: 'auto' } });
    expect((await call('GET', '/admin/settings', admin)).body.settings.presetCodecs).toEqual({
      game: 'av1Save',
    });
    expect((await space()).av1QualityPresets).toBeUndefined();
    // Without AV1 allowed, no preset is on AV1 quality either.
    await call('PUT', '/admin/settings', admin, {
      ...next,
      allowAv1: false,
    });
    expect((await space()).av1QualityPresets).toBeUndefined();
  });

  it('reads a stored `auto` (from before AV1 modes) as AV1 save data', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value_json, updated_at) VALUES ('room_limits', ?, 0)`,
    )
      .bind(JSON.stringify({ allowAv1: true, presetCodecs: { text: 'auto', game: 'h264' } }))
      .run();
    expect((await call('GET', '/admin/settings', admin)).body.settings.presetCodecs).toEqual({
      text: 'av1Save',
      game: 'h264',
    });
  });

  it('accepts a bitrate limit up to the highest preset send, in full (native, 29.6 Mbps)', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    expect(SETTINGS_BOUNDS.maxBitrateKbps.max).toBe(30_000);
    expect(SETTINGS_BOUNDS.maxBitrateKbps.max).toBeGreaterThanOrEqual(
      presetSendKbps('native', true),
    );
    const next = { ...DEFAULTS, maxBitrateKbps: 30_000 };
    expect(await call('PUT', '/admin/settings', admin, next)).toEqual({
      status: 200,
      body: { settings: next },
    });
  });

  it('validates every field with a JSON Pointer', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const bad: [Record<string, unknown>, string][] = [
      [{ maxResolution: '720p' }, '/maxResolution'],
      [{ maxFps: 45 }, '/maxFps'],
      [{ maxFps: 144 }, '/maxFps'],
      [{ maxBitrateKbps: 500 }, '/maxBitrateKbps'],
      [{ maxBitrateKbps: 30_001 }, '/maxBitrateKbps'],
      [{ maxViewersPerStream: 0 }, '/maxViewersPerStream'],
      [{ maxViewersPerStream: 2.5 }, '/maxViewersPerStream'],
      [{ maxStreamsPerRoom: 21 }, '/maxStreamsPerRoom'],
      [{ quotaMode: 'off' }, '/quotaMode'],
      [{ autoEconomy: 1 }, '/autoEconomy'],
      [{ budget: 'free' }, '/budget'],
      [{ budget: { kind: 'premium' } }, '/budget/kind'],
      [{ budget: { kind: 'preset', limitGB: 1800 } }, '/budget/limitGB'],
      [{ budget: { kind: 'custom', limitGB: 0 } }, '/budget/limitGB'],
      [{ budget: { kind: 'custom', limitGB: 100_001 } }, '/budget/limitGB'],
      [{ budget: { kind: 'custom', limitGB: 12.5 } }, '/budget/limitGB'],
      [{ budget: { kind: 'custom' } }, '/budget/limitGB'],
      [{ budget: { kind: 'free', limitGB: 1000 } }, '/budget'],
      [{ cycleResetDay: 0 }, '/cycleResetDay'],
      [{ cycleResetDay: 32 }, '/cycleResetDay'],
      [{ overheads: 'yes' }, '/overheads'],
      [{ signup: 'anyone' }, '/signup'],
      [{ spaceCreation: 'everyone' }, '/spaceCreation'],
      [{ extra: 1 }, ''],
    ];
    for (const [change, path] of bad) {
      expect(await call('PUT', '/admin/settings', admin, { ...DEFAULTS, ...change })).toEqual({
        status: 400,
        body: { code: 'invalid_message', path },
      });
    }
    const missing: Record<string, unknown> = { ...DEFAULTS };
    delete missing['maxFps'];
    expect((await call('PUT', '/admin/settings', admin, missing)).body.path).toBe('/maxFps');
  });

  it('saves the sign-up and space creation policies, with their own audit entry on change', async () => {
    await setAccess(null);
    const admin = await newUser('admin', { platformAdmin: true });
    const accessAudit = () =>
      env.DB.prepare(
        "SELECT data_json FROM audit_log WHERE action = 'platform.access.update' AND actor_id = ?",
      )
        .bind(admin)
        .all<{ data_json: string }>();

    // Saving the other settings with the policies unchanged adds no access entry.
    await call('PUT', '/admin/settings', admin, { ...DEFAULTS, maxStreamsPerRoom: 3 });
    expect((await accessAudit()).results).toEqual([]);

    const open = { ...DEFAULTS, signup: 'open', spaceCreation: 'members' };
    expect(await call('PUT', '/admin/settings', admin, open)).toEqual({
      status: 200,
      body: { settings: open },
    });
    const { results } = await accessAudit();
    expect(results.map((r) => JSON.parse(r.data_json))).toEqual([
      {
        from: { signup: 'invite_only', spaceCreation: 'admin_only' },
        to: { signup: 'open', spaceCreation: 'members' },
      },
    ]);
    const signup = await call('GET', '/auth/policy');
    expect(signup).toEqual({ status: 200, body: { signup: 'open' } });
  });
});

describe('GET /api/auth/policy', () => {
  it('reports invite_only only once the instance has a platform admin', async () => {
    await setAccess(null);
    await env.DB.prepare('UPDATE users SET is_platform_admin = 0').run();
    // No admin yet and an install code set: the owner must be able to sign up and claim it.
    expect((await call('GET', '/auth/policy')).body).toEqual({ signup: 'open' });
    await newUser('admin', { platformAdmin: true });
    expect((await call('GET', '/auth/policy')).body).toEqual({ signup: 'invite_only' });
    await setAccess({ signup: 'open', spaceCreation: 'admin_only' });
    expect((await call('GET', '/auth/policy')).body).toEqual({ signup: 'open' });
  });
});

describe('space suspension', () => {
  it('closes the rooms, keeps everyone out, audits, and can be lifted', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    const roomId = await fixedRoom(w);
    const { client } = await Client.join(roomId, w.member);

    const res = await call('POST', `/admin/spaces/${w.spaceId}/suspend`, admin);
    expect(res.status).toBe(200);
    expect(res.body.space).toMatchObject({ id: w.spaceId, suspendedAt: expect.any(Number) });
    expect((await client.take('room.closed')).payload).toEqual({ reason: 'suspended' });
    expect((await client.closed).code).toBe(4005);

    expect(await call('GET', `/spaces/${w.spaceId}`, w.owner)).toEqual({
      status: 403,
      body: { code: 'space_suspended', spaceId: w.spaceId },
    });
    expect((await call('GET', `/spaces/${w.spaceId}/rooms`, w.member)).body.code).toBe(
      'space_suspended',
    );
    const socket = await upgrade(roomId, w.member);
    expect(socket.status).toBe(403);
    expect(await socket.json()).toEqual({ code: 'space_suspended', roomId });
    // Members still see it in their list, flagged.
    const me = await call('GET', '/me', w.member);
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ spaceId: w.spaceId, suspended: true }),
    ]);
    // The overview shows it suspended.
    const overview = await call('GET', '/admin/overview', admin);
    expect(
      overview.body.spaces.find((s: { id: string }) => s.id === w.spaceId).suspendedAt,
    ).toEqual(res.body.space.suspendedAt);

    // Suspending again changes nothing.
    const again = await call('POST', `/admin/spaces/${w.spaceId}/suspend`, admin);
    expect(again.body.space.suspendedAt).toBe(res.body.space.suspendedAt);

    const lifted = await call('POST', `/admin/spaces/${w.spaceId}/unsuspend`, admin);
    expect(lifted).toEqual({ status: 200, body: { space: { id: w.spaceId, suspendedAt: null } } });
    expect((await call('GET', `/spaces/${w.spaceId}`, w.owner)).status).toBe(200);
    expect((await auditRows(w.spaceId)).filter((r) => r.action.startsWith('platform.'))).toEqual([
      expect.objectContaining({
        actor_id: admin,
        action: 'platform.space.suspend',
        target: w.spaceId,
      }),
      expect.objectContaining({ actor_id: admin, action: 'platform.space.unsuspend' }),
    ]);
  });

  it('answers 404 for an unknown space', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    expect(await call('POST', '/admin/spaces/s_unknown/suspend', admin)).toEqual({
      status: 404,
      body: { code: 'space_not_found', spaceId: 's_unknown' },
    });
  });
});

describe('GET /api/me: quota and claim', () => {
  it('gives every user the quota level as codes, never the numbers', async () => {
    const w = await world();
    const levels: [number, string, boolean, boolean][] = [
      [100, 'ok', false, false],
      [700, 'warn_70', false, false],
      [900, 'warn_90', false, false],
      [960, 'warn_90', true, true],
      [1000, 'warn_100', true, true],
    ];
    for (const [gb, level, economyMode, blockNewStreams] of levels) {
      await env.DB.prepare('DELETE FROM usage_daily').run();
      await estimate(w.spaceId, gb);
      const res = await call('GET', '/me', w.guest);
      expect(res.body.quota).toEqual({
        level,
        limitGB: 1000,
        mode: 'block',
        freeTierExceeded: false,
        economyMode,
        blockNewStreams,
      });
    }
  });

  it('is relative to the chosen limit, with the free-tier notice and the cost for the admin', async () => {
    const admin = await newUser('admin', { platformAdmin: true });
    const w = await world();
    await call('PUT', '/admin/settings', admin, {
      ...DEFAULTS,
      budget: { kind: 'preset', limitGB: 1500 },
    });
    await estimate(w.spaceId, 1_100);
    const guest = await call('GET', '/me', w.guest);
    expect(guest.body.quota).toEqual({
      level: 'warn_70',
      limitGB: 1500,
      mode: 'block',
      freeTierExceeded: true,
      economyMode: false,
      blockNewStreams: false,
    });
    const own = await call('GET', '/me', admin);
    expect(own.body.quota.costUsd).toBeCloseTo(5, 9);

    await call('PUT', '/admin/settings', admin, { ...DEFAULTS, budget: { kind: 'unlimited' } });
    await estimate(w.spaceId, 50_000, '2000-01-01'); // outside the cycle: unchanged
    expect((await call('GET', '/me', w.guest)).body.quota).toEqual({
      level: 'ok',
      limitGB: null,
      mode: 'block',
      freeTierExceeded: true,
      economyMode: false,
      blockNewStreams: false,
    });
  });

  it('offers the claim only while the instance has no platform admin and an install code', async () => {
    await env.DB.prepare('UPDATE users SET is_platform_admin = 0').run();
    const user = await newUser('first');
    expect((await call('GET', '/me', user)).body.adminClaimable).toBe(true);

    const request = new Request('http://localhost/api/me', {
      headers: { [DEV_USER_HEADER]: user },
    });
    const noCode = await worker.fetch(
      request,
      { ...env, INSTALL_CODE: undefined },
      createExecutionContext(),
    );
    expect(((await noCode.json()) as { adminClaimable: boolean }).adminClaimable).toBe(false);

    const admin = await newUser('admin', { platformAdmin: true });
    expect((await call('GET', '/me', user)).body.adminClaimable).toBe(false);
    expect((await call('GET', '/me', admin)).body.adminClaimable).toBe(false);
  });
});
