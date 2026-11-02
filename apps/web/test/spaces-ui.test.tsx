// SPDX-License-Identifier: AGPL-3.0-only
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../src/api/auth.ts';
import type { Room, Space } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

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

const membership = (space: Space): Membership => ({
  spaceId: space.id,
  name: space.name,
  slug: space.slug,
  role: space.role ?? 'member',
});

describe('Spaces', () => {
  it('shows the empty state, creates a space and opens it', async () => {
    let spaces: Space[] = [];
    const calls = fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: spaces.map(membership) }),
      'GET /api/spaces': () => Response.json({ spaces }),
      'POST /api/spaces': ({ body }) => {
        const input = body as { name: string; slug: string };
        spaces = [{ ...SPACE, ...input }];
        return Response.json({ space: spaces[0] }, { status: 201 });
      },
      'GET /api/spaces/sp_1': () => Response.json({ space: spaces[0] }),
      'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [] }),
      'GET /api/spaces/sp_1/join-requests': () => Response.json({ joinRequests: [] }),
    });
    const router = renderApp('/spaces');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'No spaces yet' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a space' });
    await user.type(within(dialog).getByLabelText('Name'), 'Sexta à Noite');
    // The address is suggested from the name, accents dropped.
    expect(within(dialog).getByLabelText('Address')).toHaveValue('sexta-a-noite');
    await user.click(within(dialog).getByRole('button', { name: 'Create space' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/s/sexta-a-noite'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Sexta à Noite',
      slug: 'sexta-a-noite',
    });
    expect(
      await screen.findByRole('heading', { name: 'Sexta à Noite', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No rooms yet' })).toBeInTheDocument();
    // An owner sees every tab and both room actions.
    for (const tab of ['Rooms', 'Members', 'Invites', 'Requests', 'Settings']) {
      expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick room' })).toBeInTheDocument();
  });

  it('hides "Create space" and says why when only the platform admin creates spaces', async () => {
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [], canCreateSpace: false }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
    });
    renderApp('/spaces');
    expect(await screen.findByRole('heading', { name: 'No spaces yet' })).toBeInTheDocument();
    expect(
      await screen.findByText(/only the platform admin creates spaces. Ask a friend/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create space' })).not.toBeInTheDocument();
  });

  it('shows a translated error when the slug is taken', async () => {
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/spaces': () =>
        Response.json({ code: 'slug_taken', slug: 'friends' }, { status: 409 }),
    });
    renderApp('/spaces');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create space' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Friends');
    await user.click(within(dialog).getByRole('button', { name: 'Create space' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The address "friends" is already in use.',
    );
  });

  it('a guest sees neither the room actions nor the manager tabs', async () => {
    const guestSpace = { ...SPACE, role: 'guest' as const };
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [membership(guestSpace)] }),
      'GET /api/spaces/sp_1': () => Response.json({ space: guestSpace }),
      'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [ROOM] }),
    });
    renderApp('/s/friends');
    expect(await screen.findByRole('link', { name: /Game night/ })).toHaveAttribute(
      'href',
      '/s/friends/r/game-night',
    );
    expect(screen.queryByRole('button', { name: 'Create room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quick room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Invites' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Requests' })).not.toBeInTheDocument();
  });
});

const TOKEN = 'a'.repeat(43);
const PREVIEW = {
  spaceName: 'Friends',
  roomName: null,
  role: 'member',
  canStream: false,
  requiresApproval: false,
  expiresAt: Date.UTC(2026, 10, 3, 12),
};

describe('Invite landing', () => {
  it('shows what you join, accepts and opens the space', async () => {
    let memberships: Membership[] = [];
    const calls = fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships }),
      [`GET /api/invites/${TOKEN}`]: () => Response.json({ invite: PREVIEW, pending: false }),
      [`POST /api/invites/${TOKEN}/accept`]: () => {
        memberships = [membership({ ...SPACE, role: 'member' })];
        return Response.json({ status: 'joined', spaceId: 'sp_1', roomId: null, role: 'member' });
      },
      'GET /api/spaces/sp_1': () => Response.json({ space: { ...SPACE, role: 'member' } }),
      'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [] }),
    });
    const router = renderApp(`/invite/${TOKEN}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Join Friends')).toBeInTheDocument();
    expect(
      screen.getByText('You join as a member: you can watch, stream and open quick rooms.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/friends'));
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/accept'))).toBe(true);
  });

  it('an invite that needs approval ends in "waiting for approval"', async () => {
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
      [`GET /api/invites/${TOKEN}`]: () =>
        Response.json({
          invite: { ...PREVIEW, roomName: 'Game night', role: 'guest', requiresApproval: true },
          pending: false,
        }),
      [`POST /api/invites/${TOKEN}/accept`]: () =>
        Response.json({ status: 'pending', joinRequest: { id: 'jr_1' } }, { status: 202 }),
    });
    renderApp(`/invite/${TOKEN}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Join Game night in Friends')).toBeInTheDocument();
    expect(screen.getByText('An owner or admin approves your request first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(
      await screen.findByRole('heading', { name: 'Waiting for approval' }),
    ).toBeInTheDocument();
  });

  it('explains an invite that can no longer be used, in Portuguese too', async () => {
    await i18n.changeLanguage('pt-BR');
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
      [`GET /api/invites/${TOKEN}`]: () =>
        Response.json({ code: 'invite_expired' }, { status: 410 }),
    });
    renderApp(`/invite/${TOKEN}`);
    expect(
      await screen.findByRole('heading', { name: 'Este convite não pode mais ser usado' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Este convite expirou.')).toBeInTheDocument();
  });
});

/** The browser WebSocket, replaced by one the test drives. */
class TestSocket {
  static instances: TestSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(type: string, payload: object) {
    act(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) }));
  }
}

describe('Room page', () => {
  it('connects to the room socket and shows who is present, live', async () => {
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [membership(SPACE)] }),
      'GET /api/spaces/sp_1': () => Response.json({ space: SPACE }),
      'GET /api/spaces/sp_1/rooms': () => Response.json({ rooms: [ROOM] }),
      'GET /api/rooms/rm_1': () => Response.json({ room: ROOM }),
    });
    renderApp('/s/friends/r/game-night');
    expect(await screen.findByText('Connecting to the room…')).toBeInTheDocument();
    // The page may also open the user hub socket (chat mention notices), in either order.
    const roomUrl = `ws://${window.location.host}/ws/rooms/rm_1`;
    await waitFor(() => expect(TestSocket.instances.some((s) => s.url === roomUrl)).toBe(true));
    const socket = TestSocket.instances.find((s) => s.url === roomUrl);
    if (!socket) throw new Error('no room socket');
    expect(socket.url).toBe(roomUrl);
    act(() => {
      socket.readyState = 1;
      socket.onopen?.();
    });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'hello',
      payload: { client: 'web' },
    });
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
      members: [{ userId: USER.id, displayName: 'Ana', role: 'owner', canStream: true }],
      streams: [],
    });
    expect(await screen.findByText('1 here')).toBeInTheDocument();
    expect(screen.queryByText('Connecting to the room…')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No one is live' })).toBeInTheDocument();
    socket.receive('member.joined', {
      member: { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: true },
    });
    expect(await screen.findByText('2 here')).toBeInTheDocument();
    // "2 here" opens who they are.
    await userEvent.click(screen.getByRole('button', { name: /2 here/ }));
    expect(await screen.findByText('Bia')).toBeInTheDocument();
    socket.receive('member.left', { userId: 'u_bia' });
    await waitFor(() => expect(screen.queryByText('Bia')).not.toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    // The owner may archive the room.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();

    socket.receive('kicked', { reason: 'banned' });
    act(() => socket.onclose?.({ code: 4004 }));
    expect(await screen.findByText('You were removed from the room')).toBeInTheDocument();
    expect(screen.getByText('You were banned from the space.')).toBeInTheDocument();
  });
});
