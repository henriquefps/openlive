// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformSettings } from '../src/api/admin.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// The settings form is large (many fields typed with userEvent): ~1 s on an idle machine, which can
// pass the 5 s default on a loaded CI runner.
vi.setConfig({ testTimeout: 20_000 });

// /admin/settings: the sections, the unsaved-changes bar, and the estimate that follows the form
// (unsaved edits included) and the scenario. The math itself is tested in packages/usage.

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

beforeAll(() => {
  // jsdom lacks what Radix Select and Slider call.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const plain = (text: string | null | undefined) => text?.replace(/[\u00a0\u202f]/g, ' ');

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

const limits = (setting: 'detect' | 'free' | 'paid', detected: 'free' | 'paid' | null) => () =>
  Response.json({
    plan: {
      setting,
      detected,
      detection: null,
      effective: setting === 'detect' ? detected : setting,
    },
  });

function setup(extra: Parameters<typeof fakeApi>[0] = {}) {
  const puts: { path: string; body: unknown }[] = [];
  fakeApi({
    'GET /api/me': () =>
      Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] }),
    'GET /api/admin/settings': () => Response.json({ settings: SETTINGS }),
    'PUT /api/admin/settings': ({ body }) => {
      puts.push({ path: '/api/admin/settings', body });
      return Response.json({ settings: body });
    },
    'PUT /api/admin/workers-plan': ({ body }) => {
      puts.push({ path: '/api/admin/workers-plan', body });
      return Response.json({ ok: true });
    },
    ...extra,
  });
  renderApp('/admin/settings');
  return { user: userEvent.setup(), puts };
}

const total = () => plain(screen.getByTestId('estimate-total').textContent);
/** The GB of one source in the breakdown. */
const source = (key: string) =>
  plain(screen.getByTestId(`estimate-${key}`).querySelector('.tabular-nums')?.textContent);

describe('/admin/settings layout', () => {
  it('groups the settings in sections with a section list, a switcher and a sticky estimate', async () => {
    setup();
    await screen.findByTestId('estimate-total');
    const sections = ['streams', 'av1', 'voice', 'budget', 'access', 'cloudflare'];
    expect(sections.map((s) => screen.getByTestId(`section-${s}`).id)).toEqual(
      sections.map((s) => `settings-${s}`),
    );
    expect(
      within(screen.getByTestId('section-streams')).getByText('Streams and quality'),
    ).toBeInTheDocument();
    // Wide screens: the section list; narrower ones: the switcher.
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(sections.map((s) => `#settings-${s}`));
    expect(nav).toHaveClass('hidden', '@5xl:block', 'sticky');
    expect(screen.getByRole('combobox', { name: 'Settings sections' })).toBeInTheDocument();
    // The estimate: a sticky column from @3xl, and below it a bar at the bottom of the screen.
    const aside = screen.getByTestId('estimate-aside');
    expect(aside).toHaveClass('hidden', '@3xl:block', 'sticky');
    const bar = screen.getByTestId('estimate-bar');
    expect(bar).toHaveClass('@3xl:hidden');
    expect(screen.getByTestId('settings-dock')).toHaveClass('sticky', 'bottom-0');
    expect(plain(within(bar).getByTestId('estimate-summary').textContent)).toContain(
      '542 GB a month',
    );
  });

  it('opens the full estimate in a bottom sheet from the bar', async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId('estimate-bar'));
    const sheet = await screen.findByRole('dialog', { name: 'Monthly estimate' });
    expect(plain(within(sheet).getByTestId('estimate-total').textContent)).toBe('542 GB');
    // The sheet and the column share the scenario.
    const friends = within(sheet).getByLabelText('Friends watching');
    await user.clear(friends);
    await user.type(friends, '2');
    expect(plain(within(sheet).getByTestId('estimate-total').textContent)).toBe('277 GB');
    expect(
      plain(within(screen.getByTestId('estimate-aside')).getByTestId('estimate-total').textContent),
    ).toBe('277 GB');
  });
});

describe('/admin/settings unsaved changes', () => {
  it('shows Save and Discard only with edits; Discard restores the saved settings', async () => {
    const { user, puts } = setup();
    await screen.findByTestId('estimate-total');
    expect(screen.queryByTestId('unsaved-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    const streams = screen.getByLabelText('Streams per room');
    await user.clear(streams);
    await user.type(streams, '3');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // Typing the saved value back is no change.
    await user.clear(streams);
    await user.type(streams, '5');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Include measured overheads' }));
    expect(total()).not.toBe('542 GB');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('switch', { name: 'Include measured overheads' })).not.toBeChecked();
    expect(total()).toBe('542 GB');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('after saving, the saved settings are the new baseline', async () => {
    const { user, puts } = setup();
    await user.click(await screen.findByRole('switch', { name: 'Invite-only sign-up' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(puts).toEqual([{ path: '/api/admin/settings', body: { ...SETTINGS, signup: 'open' } }]);
    // Discarding a later edit goes back to what was saved, not to what was loaded.
    await user.click(
      screen.getByRole('switch', { name: 'Only the platform admin creates spaces' }),
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('switch', { name: 'Invite-only sign-up' })).not.toBeChecked();
  });
});

describe('/admin/settings estimate', () => {
  it('splits streams between H.264 and AV1 by the share that decodes it, per preset mode', async () => {
    const { user } = setup();
    await screen.findByTestId('estimate-total');
    expect(source('streamsAv1GB')).toBe('0 GB');
    expect(screen.queryByTestId('estimate-av1-share')).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Allow AV1' }));
    // 70 % of the 4 friends on AV1 save data (65 % of 7.4 Mb/s).
    expect(
      within(screen.getByTestId('estimate-aside')).getByTestId('estimate-av1-share'),
    ).toHaveTextContent('70 %');
    expect(source('streamsH264GB')).toBe('159.2 GB');
    expect(source('streamsAv1GB')).toBe('241.5 GB');
    expect(total()).toBe('412 GB');
    // Game on H.264 only: no AV1 track.
    await user.click(within(screen.getByTestId('av1-game')).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'H.264 only' }));
    expect(source('streamsAv1GB')).toBe('0 GB');
    expect(total()).toBe('542 GB');
  });

  it('plays with the scenario: friends, hours, cameras and the preset the settings allow', async () => {
    const { user } = setup();
    await screen.findByTestId('estimate-total');
    const aside = within(screen.getByTestId('estimate-aside'));
    const hours = aside.getByLabelText('Hours a day');
    await user.clear(hours);
    await user.type(hours, '4');
    // Twice the hours, twice the month: over the 1,000 GB free limit, economy mode near the end.
    expect(total()).toBe('1,085 GB');
    expect(screen.getByTestId('estimate-fit')).toHaveTextContent('Over your 1,000 GB limit');
    expect(screen.getByTestId('estimate-fit')).toHaveTextContent('Up to 3.7 hours a day');
    expect(screen.getByTestId('estimate-economy')).toBeInTheDocument();
    expect(plain(screen.getByTestId('estimate-cost').textContent)).toBe('$4.23');

    await user.type(aside.getByLabelText('Cameras on'), '{selectall}3');
    // 3 cameras × 4 others at 150 kbps, 4 h, 20 days.
    expect(source('camerasGB')).toBe('64.8 GB');

    // 1080p allows Text and Game only; the scenario keeps a preset the settings allow.
    await user.click(aside.getByRole('combobox', { name: 'Preset' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Text and code',
      'Game',
      'Max',
    ]);
    await user.click(screen.getByRole('option', { name: 'Max' }));
    await user.click(screen.getByRole('combobox', { name: 'Maximum resolution' }));
    await user.click(screen.getByRole('option', { name: '1080p' }));
    expect(screen.getByText('Game is the highest preset your settings allow.')).toBeInTheDocument();

    await user.click(aside.getByRole('button', { name: 'Reset' }));
    expect(total()).toBe('542 GB');
  });

  it('follows the capabilities: no voice, no voice or cameras in the estimate', async () => {
    const { user } = setup();
    await screen.findByTestId('estimate-total');
    expect(source('voiceGB')).toBe('11.5 GB');
    await user.click(screen.getByRole('switch', { name: /^Voice/ }));
    expect(source('voiceGB')).toBe('0 GB');
    expect(screen.getByText('Voice is off for rooms.')).toBeInTheDocument();
  });

  it('checks Durable Objects against the Workers plan, which saves with the rest', async () => {
    const { user, puts } = setup({ 'GET /api/admin/limits': limits('detect', 'free') });
    expect(await screen.findByTestId('estimate-workers')).toHaveTextContent(
      'Workers Free: about 1,094 Durable Object rows written and 1,458 requests a day, 1.5% of a daily cap.',
    );
    expect(screen.getByText('Detected: Workers Free. The estimate uses it.')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Cloudflare Workers plan' }));
    await user.click(screen.getByRole('option', { name: 'Workers Paid' }));
    expect(screen.getByTestId('estimate-workers')).toHaveTextContent(/^Workers Paid: /);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    await waitFor(() =>
      expect(puts.map((p) => p.path)).toEqual(['/api/admin/settings', '/api/admin/workers-plan']),
    );
    expect(puts[1]?.body).toEqual({ plan: 'paid' });
  });

  it('leaves the Workers note out while the plan is unknown', async () => {
    setup({ 'GET /api/admin/limits': limits('detect', null) });
    expect(await screen.findByText(/^Not detected yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('estimate-workers')).not.toBeInTheDocument();
  });

  it('formats per locale', async () => {
    await i18n.changeLanguage('pt-BR');
    setup();
    expect(plain((await screen.findByTestId('estimate-total')).textContent)).toBe('542 GB');
    expect(screen.getByTestId('estimate-fit')).toHaveTextContent('Cabe no seu limite de 1.000 GB');
    expect(
      screen.getByText('Transmissões e qualidade', { selector: '[data-slot="card-title"]' }),
    ).toBeInTheDocument();
  });
});
