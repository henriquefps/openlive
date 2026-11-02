// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Overview, PlatformSettings } from '../src/api/admin.ts';
import { CostCalculator } from '../src/components/admin/CostCalculator.tsx';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// The settings form is large (many fields typed with userEvent): ~1 s on an idle machine, which can
// pass the 5 s default on a loaded CI runner.
vi.setConfig({ testTimeout: 20_000 });

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

/** Intl puts narrow no-break spaces in some units; compare with plain spaces. */
const plain = (text: string | null | undefined) => text?.replace(/[\u00a0\u202f]/g, ' ');

/** The value (<dd>) under a metric label (<dt>). */
const metric = (label: string) => {
  const dt = screen.getByText(label, { selector: 'dt' });
  return plain(dt.nextElementSibling?.textContent);
};

const me =
  (extra: Record<string, unknown> = {}, user: Partial<typeof USER> = {}) =>
  () =>
    Response.json({ user: { ...USER, ...user }, memberships: [], ...extra });

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

describe('CostCalculator', () => {
  it('reproduces the reference example: 6 slots × 12 Mbps ≈ 32 GB an hour, ≈ 31 hours a month', () => {
    render(<CostCalculator ceiling={{ bitrateMbps: 12, slots: 6 }} overheads={false} />);
    expect(metric('One hour of a full stream')).toBe('32.4 GB');
    expect(screen.getByText('6 viewers × 12 Mb/s')).toBeInTheDocument();
    expect(metric('Full stream hours a month')).toBe('30.9 hours');
    // The typical month: 2 streams a night, 2 h each, 4 viewers, 20 nights, at 12 Mbps.
    expect(metric('Month total')).toBe('1,728 GB');
    expect(metric('Above the free tier')).toBe('728 GB');
    expect(metric('Estimated cost')).toBe('$36.40');
    // The two reference profiles side by side.
    const economy = screen.getByText('Economy').parentElement as HTMLElement;
    expect(within(economy).getByText('1080p60, 8 Mb/s, 4 slots')).toBeInTheDocument();
    expect(within(economy).getByText('14.4 GB per full hour')).toBeInTheDocument();
    expect(within(economy).getByText('69.4 hours a month')).toBeInTheDocument();
    const max = screen.getByText('Maximum').parentElement as HTMLElement;
    expect(within(max).getByText('1440p60, 12 Mb/s, 6 slots')).toBeInTheDocument();
    expect(within(max).getByText('32.4 GB per full hour')).toBeInTheDocument();
    expect(within(max).getByText('30.9 hours a month')).toBeInTheDocument();
  });

  it('adds the measured overheads when they are on', () => {
    render(<CostCalculator ceiling={{ bitrateMbps: 12, slots: 6 }} overheads />);
    // 1.5 × 32.4 GB + 6 joins × 22.5 MB.
    expect(metric('One hour of a full stream')).toBe('48.7 GB');
    expect(metric('Full stream hours a month')).toBe('20.5 hours');
  });

  it('recomputes the month as the scenario is edited', async () => {
    render(<CostCalculator ceiling={{ bitrateMbps: 8, slots: 4 }} overheads={false} />);
    const user = userEvent.setup();
    const viewers = screen.getByLabelText('Viewers per stream');
    await user.clear(viewers);
    await user.type(viewers, '3');
    // 2 × 20 streams × 3 viewers × 2 h × 3.6 GB.
    expect(metric('Month total')).toBe('864 GB');
    expect(metric('Estimated cost')).toBe('$0.00');
    await user.clear(screen.getByLabelText('Days a month'));
    expect(metric('Month total')).toBe('0 GB');
  });

  it('formats per locale', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<CostCalculator ceiling={{ bitrateMbps: 12, slots: 6 }} overheads={false} />);
    expect(metric('Uma hora de transmissão lotada')).toBe('32,4 GB');
    expect(metric('Horas lotadas por mês')).toBe('30,9 horas');
  });
});

describe('/admin/settings', () => {
  it('feeds the form values to the estimate live and saves them', async () => {
    let saved: unknown;
    const calls = fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'GET /api/admin/overview': () => Response.json({}),
      'PUT /api/admin/settings': ({ body }) => {
        saved = body;
        return Response.json({ settings: body });
      },
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    // 1 streamer and 4 friends on Game (7.4 Mb/s under the 12 Mb/s cap), 5 in voice, 2 h, 20 days.
    expect(plain((await screen.findByTestId('estimate-total')).textContent)).toBe('542 GB');

    const viewers = screen.getByLabelText('Viewers per stream', {
      selector: '[id$="-maxViewersPerStream"]',
    });
    await user.clear(viewers);
    await user.type(viewers, '2');
    // The scenario's 4 friends are held to 2.
    expect(plain(screen.getByTestId('estimate-total').textContent)).toBe('277 GB');
    expect(screen.getByText('Your settings allow 2 viewers per stream.')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Include measured overheads' }));
    expect(plain(screen.getByTestId('estimate-total').textContent)).toBe('416 GB');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(saved).toEqual({ ...SETTINGS, maxViewersPerStream: 2, overheads: true });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('shows the 120 fps presets, their cost, and that the bitrate limit cuts them', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () =>
        Response.json({ settings: { ...SETTINGS, maxFps: 120, maxBitrateKbps: 13_000 } }),
      'GET /api/admin/overview': () => Response.json({}),
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const max120 = await screen.findByTestId('fps120-max120');
    // 20 + 3.5 + 1 Mb/s and the sound; 13 Mb/s leave the top layer ~8.4.
    expect(plain(max120.textContent)).toBe(
      'Max 120: 24.6 Mb/s with its lower layers and sound, ~3.8 GB an hour per viewer. ' +
        'The 13 Mb/s limit leaves its top layer about 8.4 Mb/s instead of 20 Mb/s. ' +
        'Raise the maximum bitrate to 25 Mb/s for the full quality.Raise to 25 Mb/s',
    );
    expect(screen.getByTestId('fps120-game120')).toHaveTextContent(/Game 120: 18\.6/);

    const bitrate = screen.getByLabelText('Maximum bitrate (Mbps)');
    await user.clear(bitrate);
    await user.type(bitrate, '25');
    expect(plain(screen.getByTestId('fps120-max120').textContent)).toBe(
      'Max 120: 24.6 Mb/s with its lower layers and sound, ~9 GB an hour per viewer.',
    );
  });

  it('warns when the limit cuts native, and one click sets the field that fits it', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () =>
        Response.json({
          settings: { ...SETTINGS, maxResolution: '2160p', maxBitrateKbps: 13_000 },
        }),
      'GET /api/admin/overview': () => Response.json({}),
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const native = await screen.findByTestId('cap-native');
    expect(plain(native.textContent)).toContain('Raise to 30 Mb/s');
    expect(plain(native.textContent)).toContain('the 13 Mb/s limit leaves its top layer');
    expect(screen.getByTestId('cap-max')).toHaveTextContent('Raise to 17 Mb/s');
    expect(screen.queryByTestId('cap-text')).not.toBeInTheDocument();
    await user.click(within(native).getByRole('button', { name: /Raise to 30/ }));
    expect(screen.getByLabelText('Maximum bitrate (Mbps)')).toHaveValue(30);
    expect(screen.queryByTestId('cap-max')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cap-native')).not.toBeInTheDocument();
  });

  it('offers the raise button on a capped 120 fps preset too', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () =>
        Response.json({ settings: { ...SETTINGS, maxFps: 120, maxBitrateKbps: 13_000 } }),
      'GET /api/admin/overview': () => Response.json({}),
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const max120 = await screen.findByTestId('fps120-max120');
    await user.click(within(max120).getByRole('button', { name: 'Raise to 25 Mb/s' }));
    expect(screen.getByLabelText('Maximum bitrate (Mbps)')).toHaveValue(25);
    expect(screen.queryByTestId('raise-bitrate')).not.toBeInTheDocument();
  });

  it('says the 120 fps presets are off at 60 fps', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'GET /api/admin/overview': () => Response.json({}),
    });
    renderApp('/admin/settings');
    expect(await screen.findByTestId('fps120-off')).toHaveTextContent(/Game 120 .* are off/);
    expect(screen.queryByTestId('fps120')).not.toBeInTheDocument();
  });

  it('saves who may sign up and create spaces', async () => {
    let saved: unknown;
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'PUT /api/admin/settings': ({ body }) => {
        saved = body;
        return Response.json({ settings: body });
      },
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const inviteOnly = await screen.findByRole('switch', { name: 'Invite-only sign-up' });
    const adminSpaces = screen.getByRole('switch', {
      name: 'Only the platform admin creates spaces',
    });
    expect(inviteOnly).toBeChecked();
    expect(adminSpaces).toBeChecked();
    await user.click(inviteOnly);
    expect(
      screen.getByText('Anyone with a Discord account or an e-mail address can create an account.'),
    ).toBeInTheDocument();
    await user.click(adminSpaces);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(saved).toEqual({ ...SETTINGS, signup: 'open', spaceCreation: 'members' });
  });

  it('allows AV1 with a codec per preset (save data, quality, H.264) and what a viewer costs in each', async () => {
    let saved: unknown;
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'PUT /api/admin/settings': ({ body }) => {
        saved = body;
        return Response.json({ settings: body });
      },
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const allow = await screen.findByRole('switch', { name: 'Allow AV1' });
    expect(allow).not.toBeChecked();
    expect(screen.queryByTestId('av1-game')).not.toBeInTheDocument();
    await user.click(allow);
    // 1440p60: text, game and max, each on AV1 save data.
    expect(['text', 'game', 'max'].map((p) => screen.queryByTestId(`av1-${p}`) !== null)).toEqual([
      true,
      true,
      true,
    ]);
    expect(screen.queryByTestId('av1-native')).not.toBeInTheDocument();
    const game = screen.getByTestId('av1-game');
    expect(game).toHaveTextContent('AV1: save data');
    expect(game).toHaveTextContent('Save data: ~35 % less bandwidth, similar picture.');
    // Without overheads, under the 12 Mb/s cap (top layer ~7.4 Mb/s): 65 % of it to save data,
    // all of it for quality.
    expect(plain(game.textContent)).toContain(
      '~3.3 GB an hour per viewer on H.264, ~2.2 GB on AV1 save data, ~3.3 GB on AV1 quality.',
    );
    // The three choices. jsdom lacks what Radix Select calls to open.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    await user.click(within(game).getByRole('combobox'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'AV1: save data',
      'AV1: quality',
      'H.264 only',
    ]);
    await user.click(screen.getByRole('option', { name: 'AV1: quality' }));
    expect(game).toHaveTextContent('Quality: same bandwidth as H.264, sharper motion.');
    await user.click(within(screen.getByTestId('av1-max')).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'H.264 only' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(saved).toEqual({
      ...SETTINGS,
      allowAv1: true,
      presetCodecs: { game: 'av1Quality', max: 'h264' },
    });
  });

  it('offers the monthly limits with their maximum cost and full-stream hours', async () => {
    let saved: unknown;
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'PUT /api/admin/settings': ({ body }) => {
        saved = body;
        return Response.json({ settings: body });
      },
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const free = await screen.findByRole('radio', { name: /Free tier/ });
    expect(free).toBeChecked();
    // 6 slots × 12 Mbps without overheads: 32.4 GB a full hour.
    const card = (choice: string) => plain(screen.getByTestId(`budget-${choice}`).textContent);
    expect(card('free')).toContain('$0.00 a month, free');
    expect(card('free')).toContain('About 30.9 hours of full streams');
    expect(card('1500')).toContain('Up to $25.00 a month');
    expect(card('1500')).toContain('About 46.3 hours of full streams');
    expect(card('2000')).toContain('Up to $50.00 a month');
    expect(card('5000')).toContain('Up to $200.00 a month');
    expect(card('5000')).toContain('About 154.3 hours');
    expect(card('unlimited')).toContain('No cap on the cost');
    // The estimate follows the chosen limit.
    expect(screen.getByTestId('estimate-fit')).toHaveTextContent('Fits your 1,000 GB limit');
    await user.click(screen.getByRole('radio', { name: /2,000 GB/ }));
    expect(screen.getByTestId('estimate-fit')).toHaveTextContent('Fits your 2,000 GB limit');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(saved).toEqual({ ...SETTINGS, budget: { kind: 'preset', limitGB: 2000 } });
  });

  it('takes a custom limit in GB or as a monthly amount in US$', async () => {
    let saved: unknown;
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
      'PUT /api/admin/settings': ({ body }) => {
        saved = body;
        return Response.json({ settings: body });
      },
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Custom/ }));
    const gb = screen.getByLabelText('Limit (GB)');
    const usd = screen.getByLabelText('Or a monthly amount (US$)');
    expect(gb).toHaveValue(3000);
    expect(usd).toHaveValue(100);
    await user.clear(usd);
    await user.type(usd, '10');
    expect(gb).toHaveValue(1200);
    expect(plain(screen.getByTestId('budget-custom').textContent)).toContain('Up to $10.00');
    await user.clear(gb);
    await user.type(gb, '0');
    expect(gb).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(gb);
    await user.type(gb, '2500');
    expect(usd).toHaveValue(75);
    // Economy mode can be turned off.
    await user.click(screen.getByRole('switch', { name: 'Economy mode near the limit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(saved).toEqual({
      ...SETTINGS,
      budget: { kind: 'custom', limitGB: 2500 },
      autoEconomy: false,
    });
  });

  it('hides "when the limit is reached" for an unlimited budget', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    expect(await screen.findByLabelText('When the limit is reached')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Unlimited/ }));
    expect(screen.queryByLabelText('When the limit is reached')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Economy mode near the limit' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Streams are never blocked for usage/)).toBeInTheDocument();
  });

  it('refuses to save a value out of range', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
    });
    renderApp('/admin/settings');
    const user = userEvent.setup();
    const day = await screen.findByLabelText('Billing cycle reset day');
    await user.clear(day);
    await user.type(day, '32');
    expect(day).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('/admin/claim', () => {
  it('claims the instance with the install code', async () => {
    let admin = false;
    const calls = fakeApi({
      'GET /api/me': () => me({ adminClaimable: !admin }, { isPlatformAdmin: admin })(),
      'POST /api/admin/claim': ({ body }) => {
        if ((body as { code: string }).code !== 'k7f-2qm') {
          return Response.json({ code: 'install_code_invalid' }, { status: 403 });
        }
        admin = true;
        return Response.json({ user: { ...USER, isPlatformAdmin: true } });
      },
      'GET /api/admin/overview': () => Response.json({ code: 'internal_error' }, { status: 500 }),
    });
    const router = renderApp('/admin/claim');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Install code');
    // The sidebar offers the claim while there is no admin.
    expect(screen.getByRole('link', { name: 'Claim this instance' })).toBeInTheDocument();

    await user.type(input, 'wrong');
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('The install code is not correct.')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '  k7f-2qm ');
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/setup'));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { code: 'wrong' },
      { code: 'k7f-2qm' },
    ]);
    expect(await screen.findByRole('link', { name: 'Platform' })).toBeInTheDocument();
  });

  it('says so when the instance already has an admin', async () => {
    fakeApi({ 'GET /api/me': me({ adminClaimable: false }) });
    renderApp('/admin/claim');
    expect(
      await screen.findByText('This instance already has a platform admin.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Install code')).not.toBeInTheDocument();
  });

  it('keeps non-admins out of /admin: to the claim page while it is open, else home', async () => {
    fakeApi({
      'GET /api/me': me({ adminClaimable: true }),
      'GET /api/health': () => Response.json({ ok: true }),
    });
    const first = renderApp('/admin');
    await waitFor(() => expect(first.state.location.pathname).toBe('/admin/claim'));
  });

  it('sends a non-admin home once the instance is claimed', async () => {
    fakeApi({
      'GET /api/me': me({ adminClaimable: false }),
      'GET /api/health': () => Response.json({ ok: true }),
    });
    const router = renderApp('/admin/settings');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

const OVERVIEW: Overview = {
  cycle: { start: '2026-10-01', end: '2026-11-01', daysLeft: 5 },
  quota: {
    budget: 'free',
    quotaGB: 1000,
    freeTierGB: 1000,
    mode: 'block',
    autoEconomy: true,
    level: 'ok',
    usedGB: 412,
    usedFraction: 0.412,
    source: 'estimate',
    freeTierExceeded: false,
    economyMode: false,
    blockNewStreams: false,
    cost: { gbAboveFree: 0, usd: 0 },
    projection: { projectedGB: 492, cappedAtLimit: false, cost: { gbAboveFree: 0, usd: 0 } },
  },
  usage: { estimatedGB: 412, realGB: 398.5, viewerMinutes: 0, streamMinutes: 0 },
  spaces: [
    {
      id: 's_1',
      name: 'Friends',
      slug: 'friends',
      createdAt: 0,
      suspendedAt: null,
      members: 5,
      estimatedGB: 412,
      viewerMinutes: 0,
      streamMinutes: 0,
    },
  ],
};

describe('/admin overview', () => {
  it('shows the summary strip and suspends a space', async () => {
    let overview = OVERVIEW;
    const calls = fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () => Response.json(overview),
      'POST /api/admin/spaces/s_1/suspend': () => {
        const [space] = OVERVIEW.spaces;
        overview = {
          ...OVERVIEW,
          spaces: [{ ...(space as (typeof OVERVIEW.spaces)[0]), suspendedAt: 1 }],
        };
        return Response.json({ space: { id: 's_1', suspendedAt: 1 } });
      },
    });
    renderApp('/admin');
    const user = userEvent.setup();
    expect(await screen.findByText('412 of 1,000 GB')).toBeInTheDocument();
    expect(screen.getByText('412 GB estimated')).toBeInTheDocument();
    expect(screen.getByText('398.5 GB reported')).toBeInTheDocument();
    expect(screen.getByText('5 days')).toBeInTheDocument();
    expect(screen.getByText('Turns over on Nov 1, 2026')).toBeInTheDocument();
    expect(metric('Cost so far')).toBe('$0.00');
    expect(screen.getByText('Within the free tier')).toBeInTheDocument();
    expect(metric('Projected this cycle')).toBe('$0.00');
    expect(screen.getByText('492 GB at the pace so far')).toBeInTheDocument();
    expect(plain(screen.getByTestId('quota-strip').textContent)).toBe(
      '412 of 1,000 GB · $0.00 so far · projected $0.00 this month',
    );

    await user.click(screen.getByRole('button', { name: 'Suspend Friends' }));
    expect(
      await screen.findByRole('button', { name: 'Lift the suspension of Friends' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/api/admin/spaces/s_1/suspend'),
    ).toBe(true);
  });
});

const LIMITS = {
  freeDaily: {
    doRowsWritten: 100_000,
    doRowsRead: 5_000_000,
    doRequests: 100_000,
    doDuration: 13_000,
    d1RowsWritten: 100_000,
    d1RowsRead: 5_000_000,
    workerRequests: 100_000,
  },
  paidMonthly: {
    doRowsWritten: 50_000_000,
    doRowsRead: 25_000_000_000,
    doRequests: 1_000_000,
    doDuration: 400_000,
    d1RowsWritten: 50_000_000,
    d1RowsRead: 25_000_000_000,
    workerRequests: 10_000_000,
  },
  paidUsdPerMillion: {
    doRowsWritten: 1,
    doRowsRead: 0.001,
    doRequests: 0.15,
    doDuration: 12.5,
    d1RowsWritten: 1,
    d1RowsRead: 0.001,
    workerRequests: 0.3,
  },
};

const TODAY = {
  doRowsWritten: { used: 72_000 },
  doRowsRead: { used: 10_000 },
  doRequests: { used: 95_000 },
  doDuration: { used: null, reason: 'not_exposed', detail: 'unknown field "duration"' },
  d1RowsWritten: { used: null, reason: 'permission', permission: 'Account Analytics: Read' },
  d1RowsRead: { used: 5 },
  workerRequests: { used: 100_000 },
};

/** The last 24 hours, just after 00:00 UTC: today is nearly empty, yesterday's use still counts. */
const LAST_24H = {
  ...TODAY,
  doRowsWritten: { used: 104_000 },
  d1RowsRead: { used: 0, empty: true },
};

const DEBUG = [
  {
    metric: 'doDuration',
    window: 'today',
    query: 'query Limits($account: string!, $since: Date!) { … }',
    variables: { since: '2026-10-28' },
    status: 400,
    response: '{"data":null,"errors":[{"message":"unknown field \\"duration\\""}]}',
  },
];

const LOGS = {
  sampling: 0.1,
  today: { used: 150_000 },
  last24h: { used: 160_000 },
  month: null,
  freeDaily: 200_000,
  paidMonthly: 20_000_000,
  paidUsdPerMillion: 0.6,
};

describe('/admin Cloudflare limits', () => {
  it('on Workers Free: today against the daily caps, 70 % / 90 % / 100 %, reasons', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () => Response.json(OVERVIEW),
      'GET /api/admin/limits': () =>
        Response.json({
          plan: { setting: 'detect', detected: 'free', detection: null, effective: 'free' },
          fetchedAt: Date.UTC(2026, 9, 28, 12),
          resetsAt: Date.UTC(2026, 9, 29),
          today: TODAY,
          last24h: LAST_24H,
          month: null,
          limits: LIMITS,
          logs: LOGS,
          debug: DEBUG,
        }),
    });
    renderApp('/admin');
    expect(await screen.findByText('72,000 of 100,000 (72%)')).toBeInTheDocument();
    expect(screen.getByTestId('limits-plan').textContent).toBe('Workers Free');
    expect(screen.getByText("Detected from the account's subscriptions")).toBeInTheDocument();
    // Today: rows written at 72 % and the log events at 75 %; the log events at 80 % over 24 h.
    expect(screen.getAllByText('Above 70 %')).toHaveLength(3);
    expect(screen.getAllByText('Above 90 %')).toHaveLength(2);
    expect(
      screen.getAllByText(
        "Not available: Cloudflare's analytics do not report it for this account",
      ),
    ).toHaveLength(2);
    expect(
      screen.getAllByText('Not available: the API token needs Account Analytics: Read'),
    ).toHaveLength(2);
    expect(screen.getByTestId('limits-freshness').textContent).toContain('(00:00 UTC)');
    expect(screen.getByTestId('limits-freshness').textContent).toContain('up to 24 h');
    // Today (UTC) and the last 24 hours side by side; a 0 Cloudflare had no rows for says so.
    expect(screen.getByRole('columnheader', { name: 'Last 24 hours' })).toBeInTheDocument();
    expect(screen.getByText('104,000 of 100,000 (104%)')).toBeInTheDocument();
    // Worker requests in both windows, rows written over the last 24 hours.
    expect(screen.getAllByText('Limit reached')).toHaveLength(3);
    expect(screen.getByText(/No data from Cloudflare for this window yet/)).toBeInTheDocument();
    // Cloudflare's own message under a figure it refused, and the raw answers on demand.
    expect(screen.getAllByText('Cloudflare: unknown field "duration"')).toHaveLength(2);
    const raw = screen.getByTestId('limits-raw');
    expect(raw).toHaveTextContent('Raw response from Cloudflare (1 query)');
    expect(raw).toHaveTextContent('Durable Object duration (GB-s) · today (UTC) · HTTP 400');
    // Workers Logs: estimated, with the sampling, and what happens at 100 %.
    expect(screen.getByText('150,000 of 200,000 (75%)')).toBeInTheDocument();
    expect(
      screen.getByText('Estimated: Worker and Durable Object invocations × 10% sampling'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('limits-logs-note').textContent).toContain(
      'Cloudflare keeps only 1 % of the logs until 00:00 UTC; Openlive keeps working',
    );
  });

  it('on Workers Paid: the month against the included amounts, the overage, the plan choice', async () => {
    const calls = fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () => Response.json(OVERVIEW),
      'GET /api/admin/limits': () =>
        Response.json({
          plan: {
            setting: 'detect',
            detected: null,
            detection: { reason: 'permission', permission: 'Billing Read' },
            effective: null,
          },
          fetchedAt: Date.UTC(2026, 9, 28, 12),
          resetsAt: Date.UTC(2026, 9, 29),
          today: TODAY,
          last24h: LAST_24H,
          month: null,
          limits: LIMITS,
          logs: LOGS,
          debug: DEBUG,
        }),
      'PUT /api/admin/workers-plan': () => Response.json({ plan: 'paid' }),
    });
    renderApp('/admin');
    expect(await screen.findByText('Plan unknown: choose your plan')).toBeInTheDocument();
    expect(
      screen.getByText('Not detected (the API token needs Billing Read); choose it here'),
    ).toBeInTheDocument();
    // jsdom lacks what the Radix select calls on open.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Cloudflare Workers plan' }));
    await user.click(await screen.findByRole('option', { name: 'Workers Paid' }));
    expect(
      calls.some(
        (c) =>
          c.method === 'PUT' &&
          c.path === '/api/admin/workers-plan' &&
          JSON.stringify(c.body) === '{"plan":"paid"}',
      ),
    ).toBe(true);
  });
});

describe('/admin overview with a larger limit', () => {
  it('shows the projection and an unlimited budget without a progress bar', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () =>
        Response.json({
          ...OVERVIEW,
          quota: {
            ...OVERVIEW.quota,
            budget: 'preset',
            quotaGB: 1500,
            usedGB: 1200,
            usedFraction: 0.8,
            level: 'warn_70',
            freeTierExceeded: true,
            cost: { gbAboveFree: 200, usd: 10 },
            projection: {
              projectedGB: 1500,
              cappedAtLimit: true,
              cost: { gbAboveFree: 500, usd: 25 },
            },
          },
        }),
    });
    renderApp('/admin');
    expect(await screen.findByTestId('quota-strip')).toBeInTheDocument();
    expect(plain(screen.getByTestId('quota-strip').textContent)).toBe(
      '1,200 of 1,500 GB · $10.00 so far · projected $25.00 this month',
    );
    expect(screen.getByText('1,500 GB: new streams stop at the limit')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('says there is no limit when unlimited', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () =>
        Response.json({
          ...OVERVIEW,
          quota: { ...OVERVIEW.quota, budget: 'unlimited', quotaGB: null, usedFraction: null },
        }),
    });
    renderApp('/admin');
    expect(await screen.findByText('412 GB, no limit')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/No limit: new streams are never blocked/)).toBeInTheDocument();
  });
});

describe('/admin accounts in no space', () => {
  it('links to the users page, filtered', async () => {
    fakeApi({
      'GET /api/me': me({}, { isPlatformAdmin: true }),
      'GET /api/admin/overview': () => Response.json(OVERVIEW),
    });
    renderApp('/admin');
    expect(
      await screen.findByRole('heading', { name: 'Accounts in no space' }),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Review accounts in no space' });
    expect(link).toHaveAttribute('href', '/admin/users?filter=no_space');
  });
});

const codes = (extra: Record<string, unknown> = {}) => ({
  level: 'ok',
  limitGB: 1000,
  mode: 'block',
  freeTierExceeded: false,
  economyMode: false,
  blockNewStreams: false,
  ...extra,
});

async function banner(quota: Record<string, unknown>, user: Partial<typeof USER> = {}) {
  fakeApi({
    'GET /api/me': me({ quota }, user),
    'GET /api/spaces': () => Response.json({ spaces: [] }),
  });
  renderApp('/spaces');
  expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  const alert = screen.queryByRole('alert');
  return alert ? plain(alert.textContent) : null;
}

describe('quota banner', () => {
  it('warns every signed-in user above 70 % of the chosen limit', async () => {
    const text = await banner(codes({ level: 'warn_90', limitGB: 1500, economyMode: true }));
    expect(text).toContain("90% of this month's 1,500 GB limit is used");
    expect(text).toContain('Economy mode is on: streams are capped at 1080p and 8 Mbps.');
    // Only the platform admin gets the link to the numbers.
    expect(screen.queryByRole('link', { name: 'See usage' })).not.toBeInTheDocument();
  });

  it('says new streams are blocked at the limit, with a link for the admin', async () => {
    const text = await banner(
      codes({ level: 'warn_100', economyMode: true, blockNewStreams: true }),
      { isPlatformAdmin: true },
    );
    expect(text).toContain("This month's 1,000 GB limit is reached");
    expect(text).toContain('New streams are blocked');
    expect(screen.getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/admin');
  });

  // kind × usage → what the banner says (the PR's table).
  it.each([
    ['free, 500 GB', codes(), null],
    ['free, 750 GB', codes({ level: 'warn_70' }), ['70% of', 'new streams are blocked']],
    [
      '1,500 GB, 1,100 GB',
      codes({ level: 'warn_70', limitGB: 1500, freeTierExceeded: true }),
      ["70% of this month's 1,500 GB limit", 'above the free 1,000 GB'],
    ],
    [
      '1,500 GB alerts only, 1,600 GB',
      codes({
        level: 'warn_100',
        limitGB: 1500,
        mode: 'alerts_only',
        freeTierExceeded: true,
        economyMode: true,
      }),
      ['1,500 GB limit is reached', 'alerts only', 'above the free 1,000 GB'],
    ],
    [
      '5,000 GB alerts only, 3,600 GB',
      codes({ level: 'warn_70', limitGB: 5000, mode: 'alerts_only', freeTierExceeded: true }),
      ['streams continue and only these alerts', 'above the free 1,000 GB'],
    ],
    [
      'unlimited, 1,200 GB',
      codes({ limitGB: null, freeTierExceeded: true }),
      ["This month's usage is past the free tier", 'US$ 0.05'],
    ],
    ['unlimited, 800 GB', codes({ limitGB: null }), null],
  ] as const)('%s', async (_, quota, expected) => {
    const text = await banner(quota);
    if (expected === null) expect(text).toBeNull();
    else for (const part of expected) expect(text).toContain(part);
  });

  it('shows the platform admin the cost so far once past the free tier', async () => {
    const text = await banner(codes({ limitGB: null, freeTierExceeded: true, costUsd: 12.5 }), {
      isPlatformAdmin: true,
    });
    expect(text).toContain('about $12.50 so far this cycle');
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    const text = await banner(codes({ level: 'warn_90', limitGB: 2000 }));
    expect(text).toContain('90% do limite de 2.000 GB deste mês já foi usado');
  });
});

describe('/login/verify (magic link confirmation)', () => {
  const token = 'A'.repeat(43);

  it('shows a button that posts the token; opening the page uses nothing', async () => {
    const calls = fakeApi({
      'GET /api/me': () => Response.json({ code: 'unauthenticated' }, { status: 401 }),
    });
    renderApp(`/login/verify?token=${token}`);
    const button = await screen.findByRole('button', { name: 'Sign in to Openlive' });
    const form = button.closest('form');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('action', '/api/auth/email/verify');
    expect(form?.querySelector('input[name="token"]')).toHaveValue(token);
    expect(calls.filter((c) => c.path.startsWith('/api/auth'))).toEqual([]);
  });

  it('takes the token out of the address bar and history, keeping it in the history state', async () => {
    fakeApi({ 'GET /api/me': () => Response.json({ code: 'unauthenticated' }, { status: 401 }) });
    const router = renderApp(`/login/verify?token=${token}`);
    await waitFor(() => expect(router.history.location.href).toBe('/login/verify'));
    // Replaced, not pushed: no entry with the token is left to go back to.
    expect(router.history.length).toBe(1);
    expect(router.history.location.state).toMatchObject({ verifyToken: token });
    const button = await screen.findByRole('button', { name: 'Sign in to Openlive' });
    expect(button.closest('form')?.querySelector('input[name="token"]')).toHaveValue(token);
  });

  it('says the link is incomplete without a valid token', async () => {
    fakeApi({ 'GET /api/me': () => Response.json({ code: 'unauthenticated' }, { status: 401 }) });
    renderApp('/login/verify?token=short');
    expect(await screen.findByText(/This sign-in link is incomplete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to Openlive' })).not.toBeInTheDocument();
  });
});
