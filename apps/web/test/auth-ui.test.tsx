// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n/index.ts';
import { anonymous, fakeApi, health, renderApp, signedIn } from './app-helpers.tsx';

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const SESSIONS = {
  sessions: [
    {
      id: 'a'.repeat(64),
      createdAt: Date.UTC(2026, 9, 27, 12),
      expiresAt: Date.UTC(2026, 10, 26),
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
      current: true,
    },
    {
      id: 'b'.repeat(64),
      createdAt: Date.UTC(2026, 9, 20, 9),
      expiresAt: Date.UTC(2026, 10, 19),
      userAgent:
        'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36',
      current: false,
    },
  ],
};

describe('route guard', () => {
  it('sends an anonymous visitor to Home, keeping where they were going', async () => {
    fakeApi({ 'GET /api/health': health, 'GET /api/me': anonymous });
    const router = renderApp('/settings');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.search).toEqual({ returnTo: '/settings' });
    expect(await screen.findByRole('link', { name: 'Continue with Discord' })).toHaveAttribute(
      'href',
      '/api/auth/discord/start?returnTo=%2Fsettings',
    );
  });

  it('lets a signed-in user in', async () => {
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/me/sessions': () => Response.json(SESSIONS),
    });
    const router = renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
  });
});

describe('user menu', () => {
  it('shows the name and logs out', async () => {
    const calls = fakeApi({
      'GET /api/health': health,
      'GET /api/me': signedIn(),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const router = renderApp('/spaces');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Account menu for Ana' }));
    expect(await screen.findByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout')).toBe(true);
    expect(await screen.findByRole('link', { name: 'Continue with Discord' })).toBeInTheDocument();
  });
});

describe('Settings > Sessions', () => {
  it('lists sessions and revokes another one', async () => {
    let sessions = SESSIONS;
    const calls = fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/me/sessions': () => Response.json(sessions),
      [`DELETE /api/me/sessions/${'b'.repeat(64)}`]: () => {
        sessions = { sessions: SESSIONS.sessions.slice(0, 1) };
        return new Response(null, { status: 204 });
      },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('This browser')).toBeInTheDocument();
    expect(screen.getByText('Chrome on Android')).toBeInTheDocument();
    // Only the other session can be revoked from here.
    const revoke = screen.getAllByRole('button', { name: /^Revoke the session/ });
    expect(revoke).toHaveLength(1);
    await user.click(revoke[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByText('Chrome on Android')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
});

describe('profile language', () => {
  it('applies the language saved in the profile after sign-in', async () => {
    fakeApi({
      'GET /api/health': health,
      'GET /api/me': signedIn({ locale: 'pt-BR' }),
    });
    renderApp('/');
    expect(await screen.findByText('Você entrou como Ana.')).toBeInTheDocument();
  });
});
