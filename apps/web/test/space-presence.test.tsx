// SPDX-License-Identifier: AGPL-3.0-only
import type { RoomPresence } from '@openlive/protocol';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../src/api/auth.ts';
import type { Room, Space } from '../src/api/spaces.ts';
import { sidebarPeople } from '../src/components/SidebarRooms.tsx';
import { CLOSE } from '../src/room/connection.ts';
import { SpacePresenceConnection, spaceSocketUrl } from '../src/space/connection.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';
import { FakeSocket } from './fake-socket.ts';

// Room presence in the space sidebar (PROTOCOL.md 7.8): the socket's snapshot and updates, its
// close codes and backoff, and the sidebar rows that show it.

const SERVER = {
  spaceId: 'sp_1',
  protocol: { major: 1, minor: 20 },
  minProtocol: { major: 1, minor: 0 },
  serverTime: Date.UTC(2026, 9, 27),
};

const ana = { userId: 'u_ana', displayName: 'Ana', muted: false, deafened: false };
const bia = { userId: 'u_bia', displayName: 'Bia', muted: true, deafened: false };
const caio = { userId: 'u_caio', displayName: 'Caio', muted: true, deafened: true };
const GAME: RoomPresence = {
  roomId: 'rm_1',
  voice: [ana, bia, caio],
  live: [
    { userId: 'u_ana', displayName: 'Ana', streamId: 'st_1' },
    { userId: 'u_davi', displayName: 'Davi', streamId: 'st_2' },
  ],
};

describe('SpacePresenceConnection', () => {
  let sockets: FakeSocket[];
  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket');
    return socket;
  };
  const connect = () => {
    const c = new SpacePresenceConnection({
      url: 'ws://localhost/ws/spaces/sp_1',
      tabId: 't_tab',
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 0.999_999,
    });
    c.start();
    last().open();
    return c;
  };

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says hello, takes the snapshot and follows updates', () => {
    const c = connect();
    expect(last().hello).toMatchObject({
      type: 'hello',
      payload: { client: 'web', tabId: 't_tab', protocol: { major: 1, minor: 22 } },
    });
    expect(c.getState().status).toBe('connecting');
    last().receive('space.presence', { ...SERVER, rooms: [GAME] }, '1');
    expect(c.getState()).toMatchObject({ status: 'open', rooms: { rm_1: GAME } });

    const other: RoomPresence = { roomId: 'rm_2', voice: [ana], live: [] };
    last().receive('space.presence.updated', { room: other });
    expect(Object.keys(c.getState().rooms).sort()).toEqual(['rm_1', 'rm_2']);
    // Quiet: gone.
    last().receive('space.presence.updated', { room: { roomId: 'rm_1', voice: [], live: [] } });
    expect(c.getState().rooms).toEqual({ rm_2: other });
    // A fresh snapshot (the user's access changed) replaces everything.
    last().receive('space.presence', { ...SERVER, rooms: [] });
    expect(c.getState().rooms).toEqual({});
  });

  it('reconnects with backoff after an abnormal close and stays down after 4003', () => {
    const c = connect();
    last().receive('space.presence', { ...SERVER, rooms: [GAME] }, '1');
    last().serverClose(1006);
    // The last known presence stays while reconnecting.
    expect(c.getState()).toMatchObject({ status: 'reconnecting', rooms: { rm_1: GAME } });
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    last().open();
    last().receive('space.presence', { ...SERVER, rooms: [] }, '1');
    expect(c.getState()).toMatchObject({ status: 'open', attempt: 0, rooms: {} });

    last().serverClose(CLOSE.Forbidden);
    expect(c.getState()).toMatchObject({ status: 'ended', rooms: {} });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('closes its socket on stop and does not come back', () => {
    const c = connect();
    const socket = last();
    c.stop();
    expect(socket.closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('builds the URL on the page origin', () => {
    expect(
      spaceSocketUrl('sp_1', new URL('https://openlive.example/s/x') as unknown as Location),
    ).toBe('wss://openlive.example/ws/spaces/sp_1');
  });
});

describe('sidebarPeople', () => {
  it('lists voice first, then streamers who are not in voice, LIVE on whoever streams', () => {
    expect(sidebarPeople(GAME)).toEqual([
      {
        userId: 'u_ana',
        name: 'Ana',
        avatarUrl: undefined,
        muted: false,
        deafened: false,
        live: true,
      },
      {
        userId: 'u_bia',
        name: 'Bia',
        avatarUrl: undefined,
        muted: true,
        deafened: false,
        live: false,
      },
      {
        userId: 'u_caio',
        name: 'Caio',
        avatarUrl: undefined,
        muted: true,
        deafened: true,
        live: false,
      },
      { userId: 'u_davi', name: 'Davi', avatarUrl: undefined, live: true },
    ]);
    expect(sidebarPeople(undefined)).toEqual([]);
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
  closed = false;
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
  receive(type: string, payload: object, id?: string) {
    act(() => this.onmessage?.({ data: JSON.stringify({ type, id, payload }) }));
  }
}

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
const room = (id: string, name: string): Room => ({
  id,
  spaceId: 'sp_1',
  kind: 'fixed',
  name,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  code: null,
  visibility: 'space',
  settings: {},
  createdBy: USER.id,
  createdAt: Date.UTC(2026, 9, 27),
  lastActiveAt: null,
  expiresAt: null,
  archivedAt: null,
  effectiveSettings: EFFECTIVE,
});
const MEMBERSHIP: Membership = { spaceId: 'sp_1', name: 'Friends', slug: 'friends', role: 'owner' };

describe('the sidebar rows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('show who is in voice and who is live under each room, from the space socket', async () => {
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [MEMBERSHIP] }),
      'GET /api/spaces/sp_1': () => Response.json({ space: SPACE }),
      'GET /api/spaces/sp_1/rooms': () =>
        Response.json({
          rooms: [room('rm_1', 'Game night'), room('rm_2', 'Hangout'), room('rm_3', 'Quiet')],
        }),
    });
    renderApp('/s/friends');
    const nav = await screen.findByRole('navigation', { name: 'Rooms in Friends' });
    const url = `ws://${window.location.host}/ws/spaces/sp_1`;
    await waitFor(() => expect(TestSocket.instances.some((s) => s.url === url)).toBe(true));
    const socket = TestSocket.instances.find((s) => s.url === url);
    if (!socket) throw new Error('no space socket');
    act(() => {
      socket.readyState = 1;
      socket.onopen?.();
    });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'hello',
      payload: { client: 'web' },
    });
    const crowd = Array.from({ length: 7 }, (_, i) => ({
      userId: `u_${i}`,
      displayName: `Person ${i}`,
      muted: false,
      deafened: false,
    }));
    socket.receive(
      'space.presence',
      { ...SERVER, rooms: [GAME, { roomId: 'rm_2', voice: crowd, live: [] }] },
      '1',
    );

    const row = (roomId: string) => {
      const el = nav.querySelector(`[data-room="${roomId}"]`);
      if (!(el instanceof HTMLElement)) throw new Error(`no row ${roomId}`);
      return el;
    };
    const game = within(row('rm_1'));
    await game.findByText('Ana');
    expect(game.getByRole('list', { name: 'In voice (4)' })).toBeInTheDocument();
    expect(game.getAllByText('Live')).toHaveLength(2);
    expect(game.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
    expect(game.getByRole('img', { name: 'Deafened' })).toBeInTheDocument();
    expect(game.getByText('Davi')).toBeInTheDocument();
    // The row still opens the room.
    expect(game.getByRole('link', { name: 'Game night' })).toHaveAttribute(
      'href',
      '/s/friends/r/game-night',
    );

    const hangout = within(row('rm_2'));
    expect(hangout.getAllByRole('listitem')).toHaveLength(6);
    expect(hangout.getByText('+2 more')).toBeInTheDocument();
    expect(hangout.queryByText('Person 5')).not.toBeInTheDocument();
    expect(within(row('rm_3')).queryByRole('list')).not.toBeInTheDocument();

    // Someone leaves: the row follows.
    socket.receive('space.presence.updated', { room: { roomId: 'rm_1', voice: [], live: [] } });
    await waitFor(() => expect(within(row('rm_1')).queryByText('Ana')).not.toBeInTheDocument());
  });

  it('opens no space socket where no space is shown', async () => {
    TestSocket.instances = [];
    vi.stubGlobal('WebSocket', TestSocket);
    fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [MEMBERSHIP] }),
      'GET /api/spaces': () => Response.json({ spaces: [SPACE] }),
    });
    renderApp('/spaces');
    await screen.findAllByText('Friends');
    expect(TestSocket.instances.some((s) => s.url.includes('/ws/spaces/'))).toBe(false);
  });
});
