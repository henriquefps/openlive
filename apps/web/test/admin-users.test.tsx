// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser, AdminUserDetail } from '../src/api/admin.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

// /admin/users: the list with search and filters, the detail sheet, and the
// confirmed actions (ban with a reason, unban, sign-out, unpairing, delete with "also ban" and
// the owned-spaces blocker).

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const me = () => Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] });

const BIA: AdminUser = {
  id: 'u_bia',
  displayName: 'Bia',
  avatarUrl: null,
  primaryEmail: 'bia@example.com',
  providers: ['discord', 'email'],
  isPlatformAdmin: false,
  createdAt: Date.UTC(2026, 9, 1, 12),
  lastSeenAt: Date.UTC(2026, 9, 20, 12),
  bannedAt: null,
  deviceCount: 1,
  spaces: [
    { id: 's_1', name: 'Friends', slug: 'friends', role: 'member', bannedAt: null },
    { id: 's_2', name: 'Work', slug: 'work', role: 'admin', bannedAt: 5 },
  ],
};

const CAIO: AdminUser = {
  ...BIA,
  id: 'u_caio',
  displayName: 'Caio',
  primaryEmail: null,
  providers: ['discord'],
  spaces: [{ id: 's_3', name: 'Caio home', slug: 'caio', role: 'owner', bannedAt: null }],
};

const detailOf = (user: AdminUser, extra: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  ...user,
  bannedReason: null,
  bannedBy: null,
  sessions: [
    {
      id: 'sess_1',
      createdAt: Date.UTC(2026, 9, 2),
      lastSeenAt: Date.UTC(2026, 9, 20),
      expiresAt: Date.UTC(2026, 10, 20),
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
    },
  ],
  devices: [
    {
      deviceId: 'd_1',
      name: 'Desk PC',
      os: 'linux',
      arch: 'amd64',
      helperVersion: '0.2.0',
      createdAt: 1,
    },
  ],
  audit: [
    {
      id: 'al_1',
      action: 'member.role.change',
      spaceId: 's_2',
      spaceName: 'Work',
      actorId: 'u_owner',
      actorName: 'Owner',
      target: user.id,
      data: {},
      createdAt: Date.UTC(2026, 9, 3),
    },
  ],
  streams: [
    {
      streamId: 'st_1',
      preset: 'game',
      sourceKind: 'window',
      startedAt: Date.UTC(2026, 9, 20, 20),
      viewerCount: 2,
      roomId: 'r_1',
      roomName: 'Game night',
      spaceId: 's_1',
      spaceName: 'Friends',
    },
  ],
  ...extra,
});

describe('/admin/users list', () => {
  it('shows each account with its spaces as badges, and searches and filters', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA, CAIO], nextCursor: null }),
    });
    renderApp('/admin/users');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    const row = (await screen.findByRole('button', { name: 'Bia' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('bia@example.com')).toBeInTheDocument();
    expect(within(row).getAllByText('Friends').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('Member').length).toBeGreaterThan(0);
    // A space-level ban shows on the badge.
    expect(within(row).getAllByText('banned').length).toBeGreaterThan(0);
    // Without an e-mail, the id is the mono line.
    expect(screen.getByText('u_caio')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'bia');
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/admin/users?filter=all&query=bia')).toBe(true),
    );
    // jsdom applies no container queries, so the desktop toggle group is reachable.
    await user.click(screen.getByRole('radio', { name: 'Banned' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/admin/users?filter=banned&query=bia')).toBe(true),
    );
  });

  it('opens on the filter from the URL and says when nothing matches', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [], nextCursor: null }),
    });
    renderApp('/admin/users?filter=no_space');
    expect(
      await screen.findByText('Every account belongs to a space or a room.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/admin/users?filter=no_space')).toBe(true);
  });

  it('loads the next page', async () => {
    fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: '1.u_bia' }),
    });
    const fetchMock = vi.mocked(fetch);
    renderApp('/admin/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path).includes('cursor=1.u_bia'))).toBe(
        true,
      ),
    );
  });
});

describe('/admin/users detail', () => {
  it('shows spaces, live streams, sessions, devices and activity, without content', async () => {
    fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: null }),
      'GET /api/admin/users/u_bia': () => Response.json({ user: detailOf(BIA) }),
    });
    renderApp('/admin/users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bia' }));
    const sheet = await screen.findByRole('dialog', { name: 'Bia' });
    expect(within(sheet).getByText('Discord, E-mail')).toBeInTheDocument();
    expect(within(sheet).getByText('Game night in Friends')).toBeInTheDocument();
    expect(within(sheet).getByText(/^Game since .*, 2 viewers$/)).toBeInTheDocument();
    expect(within(sheet).getByText('Firefox on Linux')).toBeInTheDocument();
    expect(within(sheet).getByText('Desk PC')).toBeInTheDocument();
    expect(within(sheet).getByText('Role changed')).toBeInTheDocument();
    expect(within(sheet).getByText(/Work · by Owner/)).toBeInTheDocument();
  });

  it('bans with a reason after confirming, then offers unban', async () => {
    let detail = detailOf(BIA);
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: null }),
      'GET /api/admin/users/u_bia': () => Response.json({ user: detail }),
      'POST /api/admin/users/u_bia/ban': () => {
        detail = { ...detail, bannedAt: Date.UTC(2026, 9, 27), bannedReason: 'spam', sessions: [] };
        return Response.json({ user: detail });
      },
    });
    renderApp('/admin/users?user=u_bia');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Bia' });
    await user.click(within(sheet).getByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Ban Bia from the instance?',
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason (optional)'), ' spam ');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        path: '/api/admin/users/u_bia/ban',
        body: { reason: 'spam' },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Unban' })).toBeInTheDocument();
    expect(screen.getByText('spam')).toBeInTheDocument();
  });

  it('signs out everywhere and unpairs helpers after confirming', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: null }),
      'GET /api/admin/users/u_bia': () => Response.json({ user: detailOf(BIA) }),
      'POST /api/admin/users/u_bia/sessions/revoke': () => Response.json({ revoked: 1 }),
      'POST /api/admin/users/u_bia/devices/revoke': () => Response.json({ revoked: 1 }),
    });
    renderApp('/admin/users?user=u_bia');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Bia' });
    await user.click(within(sheet).getByRole('button', { name: 'Sign out everywhere' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Sign Bia out everywhere?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Signed out of 1 browser.')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Unpair helpers' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Unpair the helpers of Bia?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unpair helpers' }));
    expect(await screen.findByText('Unpaired 1 helper.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/admin/users/u_bia/sessions/revoke',
      '/api/admin/users/u_bia/devices/revoke',
    ]);
  });

  it('deletes with "also ban" after confirming', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: null }),
      'GET /api/admin/users/u_bia': () => Response.json({ user: detailOf(BIA) }),
      'DELETE /api/admin/users/u_bia': () => new Response(null, { status: 204 }),
    });
    renderApp('/admin/users?user=u_bia');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Bia' });
    await user.click(within(sheet).getByRole('button', { name: 'Delete account' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Bia?' });
    await user.click(within(dialog).getByRole('switch', { name: 'Also ban' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({
        path: '/api/admin/users/u_bia',
        body: { ban: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bia' })).toBeNull());
  });

  it('blocks deleting an owner of spaces, listing them', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [CAIO], nextCursor: null }),
      'GET /api/admin/users/u_caio': () => Response.json({ user: detailOf(CAIO) }),
    });
    renderApp('/admin/users?user=u_caio');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Caio' });
    await user.click(within(sheet).getByRole('button', { name: 'Delete account' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Caio?' });
    expect(within(dialog).getByText('This account owns spaces')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Caio home' })).toHaveAttribute(
      'href',
      '/s/caio',
    );
    expect(within(dialog).getByRole('button', { name: 'Delete account' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('does not offer ban or delete on your own account', async () => {
    const self = { ...BIA, id: USER.id, displayName: 'Ana', isPlatformAdmin: true };
    fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [self], nextCursor: null }),
      [`GET /api/admin/users/${USER.id}`]: () => Response.json({ user: detailOf(self) }),
    });
    renderApp(`/admin/users?user=${USER.id}`);
    const sheet = await screen.findByRole('dialog', { name: 'Ana' });
    expect(within(sheet).getByRole('button', { name: 'Ban' })).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Delete account' })).toBeDisabled();
    expect(
      within(sheet).getByText('This is your account: you cannot ban or delete it.'),
    ).toBeInTheDocument();
  });
});

describe('/admin/users in Portuguese', () => {
  it('translates the page', async () => {
    await i18n.changeLanguage('pt-BR');
    fakeApi({
      'GET /api/me': me,
      'GET /api/admin/users': () => Response.json({ users: [BIA], nextCursor: null }),
    });
    renderApp('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar usuários' })).toBeInTheDocument();
  });
});
