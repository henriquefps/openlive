// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinByCodeResult, Room } from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// A multi-step UI journey: 1-2 s on an idle machine, which can pass the 5 s default on a loaded CI
// runner.
vi.setConfig({ testTimeout: 20_000 });

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const CODE = 'OL-4821-0937';

const ROOM: Room = {
  id: 'rm_q',
  spaceId: 'sp_1',
  kind: 'quick',
  name: CODE,
  slug: CODE.toLowerCase(),
  code: CODE,
  visibility: 'space',
  settings: {},
  createdBy: 'u_bia',
  createdAt: Date.UTC(2026, 9, 27),
  lastActiveAt: null,
  expiresAt: Date.UTC(2026, 9, 28),
  archivedAt: null,
  effectiveSettings: {
    maxStreams: 5,
    maxViewersPerStream: 6,
    maxBitrateKbps: 8000,
    allowedPresets: ['text'],
  },
};

const joined = (extra: Partial<JoinByCodeResult> = {}): JoinByCodeResult => ({
  room: ROOM,
  spaceSlug: null,
  role: 'guest',
  granted: true,
  ...extra,
});

/** A socket that never opens: these tests stop at the room page. */
class IdleSocket {
  readyState = 0;
  send() {}
  close() {}
}

const me = () => Response.json({ user: USER, memberships: [] });

describe('Join with code', () => {
  it('shows the API error translated under the form on the Spaces page', async () => {
    const calls = fakeApi({
      'GET /api/me': me,
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/rooms/join': () => Response.json({ code: 'room_code_invalid' }, { status: 404 }),
    });
    renderApp('/spaces');
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Join with code' });
    await user.type(within(section).getByLabelText('Room code'), 'ol 1111 2222');
    await user.click(within(section).getByRole('button', { name: 'Join' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'No open quick room has this code. Check it and try again.',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ code: 'ol 1111 2222' });
  });

  it('translates the rate limit with its wait, in Portuguese too', async () => {
    await i18n.changeLanguage('pt-BR');
    fakeApi({
      'GET /api/me': me,
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/rooms/join': () =>
        Response.json({ code: 'rate_limited', retryAfterMs: 61_000 }, { status: 429 }),
    });
    renderApp('/spaces');
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Entrar com código' });
    await user.type(within(section).getByLabelText('Código da sala'), CODE);
    await user.click(within(section).getByRole('button', { name: 'Entrar' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Pedidos demais. Tente de novo em 2 min.',
    );
  });

  it('opens from the user menu and takes a member to the room in its space', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    fakeApi({
      'GET /api/me': me,
      'GET /api/health': () => Response.json({ ok: true, version: '0.1.0' }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/rooms/join': () =>
        Response.json(joined({ spaceSlug: 'friends', role: 'member', granted: false })),
    });
    const router = renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Ana/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Join with code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Join with code' });
    await user.type(within(dialog).getByLabelText('Room code'), CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/s/friends/r/${CODE.toLowerCase()}`),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('/join/:code deep link', () => {
  it('joins once and opens the room by id for a guest of that room only', async () => {
    vi.stubGlobal('WebSocket', IdleSocket);
    const calls = fakeApi({
      'GET /api/me': me,
      'POST /api/rooms/join': () => Response.json(joined()),
      'GET /api/rooms/rm_q': () => Response.json({ room: ROOM }),
    });
    const router = renderApp(`/join/${CODE}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/rooms/rm_q'));
    const joins = calls.filter((c) => c.path === '/api/rooms/join');
    expect(joins).toEqual([{ method: 'POST', path: '/api/rooms/join', body: { code: CODE } }]);
    // The join page is replaced, so Back does not join again.
    expect(router.history.length).toBe(1);
  });

  it('explains a closed room and offers the form with the code filled in', async () => {
    fakeApi({
      'GET /api/me': me,
      'POST /api/rooms/join': () =>
        Response.json({ code: 'room_closed', roomId: 'rm_q' }, { status: 410 }),
    });
    renderApp(`/join/${CODE}`);
    expect(
      await screen.findByRole('heading', { name: 'Could not join the room' }),
    ).toBeInTheDocument();
    expect(screen.getByText('This room is closed.')).toBeInTheDocument();
    expect(screen.getByLabelText('Room code')).toHaveValue(CODE);
  });

  it('sends a signed-out visitor to sign in first, then back to the link', async () => {
    fakeApi({ 'GET /api/me': () => Response.json({ code: 'unauthenticated' }, { status: 401 }) });
    const router = renderApp(`/join/${CODE}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.search).toEqual({ returnTo: `/join/${CODE}` });
  });
});
