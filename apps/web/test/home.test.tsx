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

describe('HomePage', () => {
  it('shows the pt-BR text and the server version when the language is pt-BR', async () => {
    await i18n.changeLanguage('pt-BR');
    fakeApi({ 'GET /api/health': health, 'GET /api/me': anonymous });
    renderApp('/');
    expect(
      await screen.findByText('Compartilhe sua tela em salas privadas com seus amigos.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Versão do servidor 0.1.0 (c820e1f)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continuar com o Discord' })).toHaveAttribute(
      'href',
      '/api/auth/discord/start',
    );
  });

  it('shows a translated error when the API fails', async () => {
    fakeApi({
      'GET /api/health': () =>
        Response.json({ code: 'rate_limited', retryAfterMs: 3000 }, { status: 429 }),
      'GET /api/me': anonymous,
    });
    renderApp('/');
    expect(await screen.findByText('Too many requests. Try again in 3 sec.')).toBeInTheDocument();
  });

  it('sends a magic link and shows "check your inbox"', async () => {
    const calls = fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'POST /api/auth/email/start': () => Response.json({ sent: true }, { status: 202 }),
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.getByText(/We sent a sign-in link to ana@example.com/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      email: 'ana@example.com',
      locale: 'en',
    });
    await user.click(screen.getByRole('button', { name: 'Use another e-mail' }));
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
  });

  it('translates an e-mail error code', async () => {
    fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'POST /api/auth/email/start': () =>
        Response.json({ code: 'rate_limited', retryAfterMs: 60_000 }, { status: 429 }),
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Too many requests. Try again in 1 min.')).toBeInTheDocument();
  });

  it('shows the login error the API redirected with', async () => {
    fakeApi({ 'GET /api/health': health, 'GET /api/me': anonymous });
    renderApp('/?authError=magic_link_invalid');
    expect(
      await screen.findByText(
        'This sign-in link has expired or was already used. Request a new one.',
      ),
    ).toBeInTheDocument();
  });

  it('offers to link a Discord account by e-mail', async () => {
    const calls = fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'POST /api/auth/email/start': () => Response.json({ sent: true }, { status: 202 }),
    });
    renderApp('/?auth=link_offer');
    const user = userEvent.setup();
    expect(await screen.findByText('You already have an account')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ link: true, locale: 'en' });
  });

  it('greets a signed-in user instead of the sign-in buttons', async () => {
    fakeApi({ 'GET /api/health': health, 'GET /api/me': signedIn() });
    renderApp('/');
    expect(await screen.findByText('Signed in as Ana.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue with Discord' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Account menu for Ana' })).toBeInTheDocument(),
    );
  });

  it('says the instance is invite-only, and that no e-mail may come without an invite', async () => {
    fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'GET /api/auth/policy': () => Response.json({ signup: 'invite_only' }),
      'POST /api/auth/email/start': () => Response.json({ sent: true }, { status: 202 }),
    });
    renderApp('/');
    expect(
      await screen.findByText(/This instance is invite-only: to create an account, ask for an/),
    ).toBeInTheDocument();
    expect(screen.queryByText('No account yet? Signing in creates one.')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(
      await screen.findByText(/new addresses get a link only when they come from an invite/),
    ).toBeInTheDocument();
  });

  it('carries the invite of the page that sent the visitor here into both logins', async () => {
    const token = 'a'.repeat(43);
    const calls = fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'GET /api/auth/policy': () => Response.json({ signup: 'invite_only' }),
      'POST /api/auth/email/start': () => Response.json({ sent: true }, { status: 202 }),
    });
    renderApp(`/?returnTo=${encodeURIComponent(`/invite/${token}`)}`);
    expect(await screen.findByText(/Sign in to accept your invite/)).toBeInTheDocument();
    expect(screen.queryByText(/ask for an invite link/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Discord' })).toHaveAttribute(
      'href',
      `/api/auth/discord/start?returnTo=%2Finvite%2F${token}&invite=${token}`,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    await screen.findByText('Check your inbox');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      email: 'ana@example.com',
      locale: 'en',
      returnTo: `/invite/${token}`,
      invite: token,
    });
  });

  it('carries the quick room code of /join/:code', async () => {
    fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'GET /api/auth/policy': () => Response.json({ signup: 'invite_only' }),
    });
    renderApp(`/?returnTo=${encodeURIComponent('/join/OL-1234-5678')}`);
    expect(await screen.findByText(/Sign in to join the room/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue with Discord' })).toHaveAttribute(
      'href',
      '/api/auth/discord/start?returnTo=%2Fjoin%2FOL-1234-5678&code=OL-1234-5678',
    );
  });

  it('translates signup_invite_required from the login redirect', async () => {
    fakeApi({ 'GET /api/health': health, 'GET /api/me': anonymous });
    renderApp('/?authError=signup_invite_required');
    expect(
      await screen.findByText(/open the invite link or room link you were sent/),
    ).toBeInTheDocument();
  });
});
