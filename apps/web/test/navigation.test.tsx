// SPDX-License-Identifier: AGPL-3.0-only
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser } from '../src/api/admin.ts';
import type { Membership } from '../src/api/auth.ts';
import type { Room, Space } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// Page headers below the top level: the breadcrumb trail (every level a link but the current
// page), the back button to the parent level, and the "← Parent" collapse below 768 px.

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const EFFECTIVE = {
  maxStreams: 4,
  maxViewersPerStream: 6,
  maxBitrateKbps: 8000,
  allowedPresets: ['text', 'game'] as Space['effectiveSettings']['allowedPresets'],
};

const SPACE: Space = {
  id: 'sp_1',
  name: 'Friends',
  slug: 'friends',
  ownerId: USER.id,
  plan: 'free',
  settings: {},
  createdAt: Date.UTC(2026, 9, 27),
  role: 'owner',
  effectiveSettings: EFFECTIVE,
};

const ROOM: Room = {
  id: 'rm_1',
  spaceId: 'sp_1',
  kind: 'fixed',
  name: 'Game night',
  slug: 'game-night',
  code: null,
  visibility: 'space',
  settings: {},
  createdBy: USER.id,
  createdAt: Date.UTC(2026, 9, 27),
  lastActiveAt: null,
  expiresAt: null,
  archivedAt: null,
  effectiveSettings: EFFECTIVE,
};

const MEMBERSHIP: Membership = { spaceId: 'sp_1', name: 'Friends', slug: 'friends', role: 'owner' };

/** A socket that never opens: the room stays "connecting". */
class IdleSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

const spaceApi = (extra: Parameters<typeof fakeApi>[0] = {}) =>
  fakeApi({
    'GET /api/me': () => Response.json({ user: USER, memberships: [MEMBERSHIP] }),
    'GET /api/spaces/sp_1': () => Response.json({ space: SPACE }),
    'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [ROOM] }),
    'GET /api/spaces/sp_1/join-requests': () => Response.json({ joinRequests: [] }),
    'GET /api/spaces/sp_1/members': () => Response.json({ members: [] }),
    'GET /api/rooms/rm_1': () => Response.json({ room: ROOM }),
    ...extra,
  });

// `hidden`: a modal sheet over the page (the open account on /admin/users) hides it from the
// accessibility tree, though the header still shows behind the overlay.
const breadcrumb = (name = 'Breadcrumb', hidden = false) =>
  screen.findByRole('navigation', { name, hidden });

/** The full trail's levels, in order (the separators are presentational). */
async function trail(name?: string, hidden = false) {
  const nav = await breadcrumb(name, hidden);
  return within(nav)
    .getAllByRole('listitem', { hidden })
    .map((item) => item.textContent);
}

/** Checks the trail's links, the current page, the back button and the mobile collapse. */
async function expectHeader({
  levels,
  links,
  back,
  hidden = false,
}: {
  levels: string[];
  links: Record<string, string>;
  back: { name: string; href: string };
  hidden?: boolean;
}) {
  await waitFor(async () => expect(await trail(undefined, hidden)).toEqual(levels));
  const nav = await breadcrumb(undefined, hidden);
  const list = within(nav).getByRole('list', { hidden });
  for (const [label, href] of Object.entries(links)) {
    expect(within(list).getByRole('link', { name: label, hidden })).toHaveAttribute('href', href);
  }
  const current = list.querySelector('[aria-current="page"]');
  expect(current).toHaveTextContent(levels.at(-1) ?? '');
  expect(list.querySelectorAll('[aria-current]')).toHaveLength(1);
  expect(current?.closest('a')).toBeNull();
  // The icon button beside the title and the collapsed "← Parent" both go to the parent level.
  const backs = screen.getAllByRole('link', { name: `Back to ${back.name}`, hidden });
  expect(backs).toHaveLength(2);
  for (const link of backs) expect(link).toHaveAttribute('href', back.href);
  const collapsed = within(nav).getByRole('link', { name: `Back to ${back.name}`, hidden });
  expect(collapsed).toHaveTextContent(back.name);
  // Below 768 px only the collapsed link shows; the full trail and the icon button are md+ only.
  expect(collapsed).toHaveClass('md:hidden');
  expect(list).toHaveClass('hidden', 'md:flex');
  const iconButton = backs.find((link) => link !== collapsed);
  expect(iconButton).toHaveClass('hidden', 'md:inline-flex');
}

describe('Breadcrumbs and back buttons', () => {
  it('has none on top-level pages', async () => {
    spaceApi({ 'GET /api/spaces': () => Response.json({ spaces: [SPACE] }) });
    renderApp('/spaces');
    expect(await screen.findByRole('heading', { name: 'Spaces', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Back/ })).not.toBeInTheDocument();
  });

  it('space: Spaces › <Space>, back to Spaces', async () => {
    spaceApi();
    renderApp('/s/friends');
    await screen.findByRole('heading', { name: 'Friends', level: 1 });
    await expectHeader({
      levels: ['Spaces', 'Friends'],
      links: { Spaces: '/spaces' },
      back: { name: 'Spaces', href: '/spaces' },
    });
  });

  it('space tab: Spaces › <Space> › <Tab>, back to the space', async () => {
    spaceApi();
    renderApp('/s/friends?tab=members');
    await screen.findByRole('heading', { name: 'Friends', level: 1 });
    await expectHeader({
      levels: ['Spaces', 'Friends', 'Members'],
      links: { Spaces: '/spaces', Friends: '/s/friends' },
      back: { name: 'Friends', href: '/s/friends' },
    });
    // Tab anchors for the tutorial stay in place.
    expect(document.querySelector('[data-tour="space-tab-members"]')).not.toBeNull();
  });

  it('room: Spaces › <Space> › <Room>, back to the space', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    spaceApi();
    renderApp('/s/friends/r/game-night');
    await screen.findByRole('heading', { name: 'Game night', level: 1 });
    await expectHeader({
      levels: ['Spaces', 'Friends', 'Game night'],
      links: { Spaces: '/spaces', Friends: '/s/friends' },
      back: { name: 'Friends', href: '/s/friends' },
    });
  });

  it('shows a skeleton for a name that is still loading', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    spaceApi({ 'GET /api/spaces/sp_1/rooms': () => new Promise<Response>(() => undefined) });
    renderApp('/s/friends/r/game-night');
    const nav = await breadcrumb();
    // The space name comes from the memberships; the room's is not known yet.
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Friends' })).toBeInTheDocument(),
    );
    const current = within(nav).getByRole('list').querySelector('[aria-current="page"]');
    expect(current?.querySelector('[data-slot="breadcrumb-skeleton"]')).not.toBeNull();
  });

  it('room by id, for a guest of one room: Spaces › <Room>, back to Spaces', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
      'GET /api/rooms/rm_1': () => Response.json({ room: ROOM }),
    });
    renderApp('/rooms/rm_1');
    await screen.findByRole('heading', { name: 'Game night', level: 1 });
    await expectHeader({
      levels: ['Spaces', 'Game night'],
      links: { Spaces: '/spaces' },
      back: { name: 'Spaces', href: '/spaces' },
    });
  });

  it('room by id, for a member: the space comes from the memberships', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    spaceApi();
    renderApp('/rooms/rm_1');
    await screen.findByRole('heading', { name: 'Game night', level: 1 });
    await expectHeader({
      levels: ['Spaces', 'Friends', 'Game night'],
      links: { Spaces: '/spaces', Friends: '/s/friends' },
      back: { name: 'Friends', href: '/s/friends' },
    });
  });

  it('watch view: … › <Room> › <Streamer>, back to the room', async () => {
    const sockets = new Map<
      string,
      { receive: (type: string, payload: object) => void; open: () => void }
    >();
    class LiveSocket extends IdleSocket {
      constructor(url: string) {
        super(url);
        sockets.set(new URL(url).pathname, {
          open: () => {
            this.readyState = 1;
            this.onopen?.();
          },
          receive: (type, payload) => this.onmessage?.({ data: JSON.stringify({ type, payload }) }),
        });
      }
    }
    vi.stubGlobal('WebSocket', LiveSocket);
    spaceApi();
    renderApp('/s/friends/r/game-night?watch=st_1');
    await screen.findByRole('heading', { name: 'Game night', level: 1 });
    // The page also opens the space and hub sockets, in an order that depends on timing: pick the
    // room's by its URL, never by position.
    await waitFor(() => expect(sockets.has('/ws/rooms/rm_1')).toBe(true));
    const socket = sockets.get('/ws/rooms/rm_1');
    if (!socket) throw new Error('no room socket');
    act(() => {
      socket.open();
      socket.receive('welcome', {
        protocol: { major: 1, minor: 0 },
        minProtocol: { major: 1, minor: 0 },
        serverTime: Date.now(),
        you: {
          userId: USER.id,
          connectionId: 'c_1',
          role: 'owner',
          permissions: { canStream: true, canModerate: true },
        },
        room: {
          roomId: 'rm_1',
          spaceId: 'sp_1',
          kind: 'fixed',
          visibility: 'space',
          name: 'Game night',
        },
        settings: EFFECTIVE,
        members: [
          { userId: USER.id, displayName: 'Ana', role: 'owner', canStream: true },
          { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: true },
        ],
        streams: [
          {
            streamId: 'st_1',
            userId: 'u_bia',
            deviceId: 'd_1',
            source: { kind: 'screen', label: 'Screen 1' },
            preset: 'game',
            hasAudio: true,
            paused: false,
            startedAt: 10,
            viewerLimit: 6,
            viewerCount: 0,
          },
        ],
      });
    });
    await expectHeader({
      levels: ['Spaces', 'Friends', 'Game night', 'Bia'],
      links: { Spaces: '/spaces', Friends: '/s/friends', 'Game night': '/s/friends/r/game-night' },
      back: { name: 'Game night', href: '/s/friends/r/game-night' },
    });
  });

  it('platform settings: Platform › Settings, back to Platform', async () => {
    fakeApi({
      'GET /api/me': () =>
        Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] }),
    });
    renderApp('/admin/settings');
    await screen.findByRole('heading', { name: 'Platform settings', level: 1 });
    await expectHeader({
      levels: ['Platform', 'Settings'],
      links: { Platform: '/admin' },
      back: { name: 'Platform', href: '/admin' },
    });
  });

  it('platform setup: Platform › Setup, back to Platform', async () => {
    fakeApi({
      'GET /api/me': () =>
        Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] }),
    });
    renderApp('/admin/setup');
    await screen.findByRole('heading', { name: 'Set up Openlive', level: 1 });
    await expectHeader({
      levels: ['Platform', 'Setup'],
      links: { Platform: '/admin' },
      back: { name: 'Platform', href: '/admin' },
    });
  });

  it('platform users: Platform › Users, then › <User> with the account open', async () => {
    const bia: AdminUser = {
      id: 'u_bia',
      displayName: 'Bia',
      avatarUrl: null,
      primaryEmail: 'bia@example.com',
      providers: ['email'],
      isPlatformAdmin: false,
      createdAt: Date.UTC(2026, 9, 1),
      lastSeenAt: null,
      bannedAt: null,
      deviceCount: 0,
      spaces: [],
    };
    fakeApi({
      'GET /api/me': () =>
        Response.json({ user: { ...USER, isPlatformAdmin: true }, memberships: [] }),
      'GET /api/admin/users': () => Response.json({ users: [bia], nextCursor: null }),
    });
    const router = renderApp('/admin/users');
    await screen.findByRole('heading', { name: 'Users', level: 1 });
    await expectHeader({
      levels: ['Platform', 'Users'],
      links: { Platform: '/admin' },
      back: { name: 'Platform', href: '/admin' },
    });
    await act(() => router.navigate({ to: '/admin/users', search: { user: 'u_bia' } }));
    await expectHeader({
      levels: ['Platform', 'Users', 'Bia'],
      links: { Platform: '/admin', Users: '/admin/users' },
      back: { name: 'Users', href: '/admin/users' },
      hidden: true,
    });
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    spaceApi();
    renderApp('/s/friends?tab=settings');
    await screen.findByRole('heading', { name: 'Friends', level: 1 });
    expect(
      await screen.findByRole('navigation', { name: 'Trilha de navegação' }),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(await trail('Trilha de navegação')).toEqual(['Spaces', 'Friends', 'Configurações']),
    );
    expect(screen.getAllByRole('link', { name: 'Voltar para Friends' })).toHaveLength(2);
  });
});
