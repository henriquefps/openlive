// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformSettings } from '../src/api/admin.ts';
import type { CheckResult, Onboarding } from '../src/api/onboarding.ts';
import type { Space } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, type Route, USER } from './app-helpers.tsx';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

// The admin onboarding wizard: step navigation, saving, skip and resume.

afterEach(async () => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  await i18n.changeLanguage('en');
});

const SETTINGS: PlatformSettings = {
  maxResolution: '1440p',
  maxFps: 60,
  maxBitrateKbps: 12_000,
  maxViewersPerStream: 6,
  maxStreamsPerRoom: 5,
  maxCamerasPerRoom: 6,
  budget: { kind: 'free' },
  quotaMode: 'block',
  autoEconomy: true,
  backgroundPause: true,
  idleCheck: true,
  cycleResetDay: 1,
  overheads: false,
  signup: 'invite_only',
  spaceCreation: 'admin_only',
  capabilities: { stream: true, voice: true, camera: true, text: true },
  allowAv1: false,
  presetCodecs: {},
};

const CHECKS: CheckResult[] = [
  { id: 'discord', status: 'ok', code: 'configured' },
  { id: 'email', status: 'missing', code: 'secret_missing', missing: ['RESEND_API_KEY'] },
  { id: 'sfu', status: 'error', code: 'auth_failed' },
  { id: 'turn', status: 'ok', code: 'configured' },
  { id: 'd1', status: 'ok', code: 'configured' },
  { id: 'r2', status: 'ok', code: 'configured' },
];

const OVERVIEW = {
  cycle: { start: '2026-10-01', end: '2026-11-01', daysLeft: 5 },
  quota: {
    budget: 'free',
    quotaGB: 1000,
    freeTierGB: 1000,
    mode: 'block',
    autoEconomy: true,
    level: 'ok',
    usedGB: 0,
    usedFraction: 0,
    source: 'estimate',
    freeTierExceeded: false,
    economyMode: false,
    blockNewStreams: false,
    cost: { gbAboveFree: 0, usd: 0 },
    projection: { projectedGB: 0, cappedAtLimit: false, cost: { gbAboveFree: 0, usd: 0 } },
  },
  usage: { estimatedGB: 0, realGB: null, viewerMinutes: 0, streamMinutes: 0 },
  spaces: [],
};

/** A fake admin API whose onboarding progress lives in memory, like the real one. */
function adminApi(start: Partial<Onboarding> = {}, extra: Record<string, Route> = {}) {
  let onboarding: Onboarding = { step: 1, completedAt: null, skippedAt: null, ...start };
  const calls = fakeApi({
    'GET /api/me': () =>
      Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] }),
    'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
    'PUT /api/admin/settings': ({ body }) => Response.json({ settings: body }),
    'GET /api/admin/checks': () => Response.json({ checks: CHECKS }),
    'GET /api/admin/overview': () => Response.json(OVERVIEW),
    'GET /api/admin/onboarding': () => Response.json({ onboarding }),
    'PUT /api/admin/onboarding': ({ body }) => {
      const { step, state } = body as { step: number; state: string };
      const now = 1_000;
      onboarding = {
        step,
        completedAt: onboarding.completedAt ?? (state === 'completed' ? now : null),
        skippedAt: onboarding.skippedAt ?? (state === 'skipped' ? now : null),
      };
      return Response.json({ onboarding });
    },
    'GET /api/spaces': () => Response.json({ spaces: [] }),
    ...extra,
  });
  const progress = () =>
    calls
      .filter((c) => c.method === 'PUT' && c.path === '/api/admin/onboarding')
      .map((c) => c.body);
  return { calls, progress };
}

const heading = (name: string) => screen.findByRole('heading', { level: 2, name });

describe('/admin/setup', () => {
  it('walks the steps forward and back and saves each step', async () => {
    const { calls, progress } = adminApi();
    renderApp('/admin/setup');
    const user = userEvent.setup();

    expect(await heading('Admin account')).toBeInTheDocument();
    expect(screen.getByText('You are the platform admin')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await heading('Checks')).toBeInTheDocument();
    // Each item with its status and code; missing secrets by name.
    const list = screen.getByRole('list', { name: 'Checks' });
    await within(list).findByText('RESEND_API_KEY');
    const email = within(list).getByText('E-mail login (Resend)').closest('li') as HTMLElement;
    expect(within(email).getByText('Missing')).toBeInTheDocument();
    expect(within(email).getByText('RESEND_API_KEY')).toBeInTheDocument();
    const sfu = within(list).getByText('Realtime SFU').closest('li') as HTMLElement;
    expect(within(sfu).getByText('Error')).toBeInTheDocument();
    expect(within(sfu).getByText(/refused the credentials/)).toBeInTheDocument();
    expect(within(list).getAllByText('OK')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await heading('Quality and slots')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('Checks')).toBeInTheDocument();

    await waitFor(() =>
      expect(progress()).toEqual([
        { step: 2, state: 'in_progress' },
        { step: 3, state: 'in_progress' },
        { step: 2, state: 'in_progress' },
      ]),
    );
    // Moving through steps 1–2 saves no settings.
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/admin/settings')).toBe(false);
  });

  it('resumes at the saved step and saves the ceilings when leaving it', async () => {
    const { calls } = adminApi({ step: 3 });
    renderApp('/admin/setup');
    const user = userEvent.setup();
    expect(await heading('Quality and slots')).toBeInTheDocument();
    // The first one is the ceiling; the calculator's scenario has a field of the same name.
    const [viewers] = screen.getAllByLabelText('Viewers per stream') as [HTMLElement];
    await user.clear(viewers);
    await user.type(viewers, '4');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await heading('What it costs')).toBeInTheDocument();
    // The mandatory cost warning (decision 24).
    expect(screen.getByText('Usage above the free quota is billed')).toBeInTheDocument();
    const saved = calls.filter((c) => c.method === 'PUT' && c.path === '/api/admin/settings');
    expect(saved.map((c) => c.body)).toEqual([{ ...SETTINGS, maxViewersPerStream: 4 }]);
  });

  it('the monthly limit step uses the same cards and saves the choice', async () => {
    const { calls } = adminApi({ step: 5 });
    renderApp('/admin/setup');
    const user = userEvent.setup();
    expect(await heading('Monthly limit')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Free tier/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /5,000 GB/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await heading('Who can join')).toBeInTheDocument();
    const saved = calls.filter((c) => c.method === 'PUT' && c.path === '/api/admin/settings');
    expect(saved.map((c) => c.body)).toEqual([
      { ...SETTINGS, budget: { kind: 'preset', limitGB: 5000 } },
    ]);
  });

  it('the access step saves who may sign up and create spaces', async () => {
    const { calls } = adminApi({ step: 6 });
    renderApp('/admin/setup');
    const user = userEvent.setup();
    expect(await heading('Who can join')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Invite-only sign-up' })).toBeChecked();
    await user.click(
      screen.getByRole('switch', { name: 'Only the platform admin creates spaces' }),
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await heading('First space and invite')).toBeInTheDocument();
    const saved = calls.filter((c) => c.method === 'PUT' && c.path === '/api/admin/settings');
    expect(saved.map((c) => c.body)).toEqual([{ ...SETTINGS, spaceCreation: 'members' }]);
  });

  it('skips for now: back to /admin with a reminder that resumes the wizard', async () => {
    const { progress } = adminApi({ step: 2 });
    const router = renderApp('/admin/setup');
    const user = userEvent.setup();
    expect(await heading('Checks')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(progress()).toEqual([{ step: 2, state: 'skipped' }]);

    expect(await screen.findByText('Setup is not finished')).toBeInTheDocument();
    expect(screen.getByText(/You stopped at step 2 of 7/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Resume setup' }));
    expect(await heading('Checks')).toBeInTheDocument();
  });

  it('the reminder can be dismissed', async () => {
    adminApi({ step: 4, skippedAt: 5 });
    renderApp('/admin');
    const user = userEvent.setup();
    expect(await screen.findByText('Setup is not finished')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Setup is not finished')).not.toBeInTheDocument();
  });

  it('opens from /admin until it is completed or skipped', async () => {
    adminApi();
    const router = renderApp('/admin');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/setup'));
    expect(await heading('Admin account')).toBeInTheDocument();
  });

  it('shows no reminder once completed', async () => {
    adminApi({ step: 7, completedAt: 5 });
    renderApp('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: 'Platform' })).toBeInTheDocument();
    expect(screen.queryByText('Setup is not finished')).not.toBeInTheDocument();
  });

  it('creates the first space in place, offers an invite, and finishes', async () => {
    const created: Space = {
      id: 'sp_1',
      name: 'Friends',
      slug: 'friends',
      ownerId: USER.id,
      plan: 'free',
      settings: {},
      createdAt: 1,
      role: 'owner',
      effectiveSettings: {
        maxStreams: 4,
        maxViewersPerStream: 6,
        maxBitrateKbps: 8000,
        allowedPresets: ['text'] as Space['effectiveSettings']['allowedPresets'],
      },
    };
    let spaces: Space[] = [];
    const { progress } = adminApi(
      { step: 7 },
      {
        'GET /api/spaces': () => Response.json({ spaces }),
        'POST /api/spaces': () => {
          spaces = [created];
          return Response.json({ space: created }, { status: 201 });
        },
        'GET /api/spaces/sp_1': () => Response.json({ space: created }),
        'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [] }),
      },
    );
    const router = renderApp('/admin/setup');
    const user = userEvent.setup();
    expect(await heading('First space and invite')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Create space' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Friends');
    await user.click(within(dialog).getByRole('button', { name: 'Create space' }));
    // Stays in the wizard.
    expect(await screen.findByText('Friends is ready')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/setup');
    expect(screen.getByRole('button', { name: 'Create invite' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(progress()).toEqual([{ step: 7, state: 'completed' }]);
  });
});
