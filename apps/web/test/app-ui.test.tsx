// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInApp } from '../src/api/app.ts';
import { anonymous, fakeApi, health, renderApp, signedIn, USER } from './app-helpers.tsx';

// The mobile app on the web: the consent page of its login, "Open in app" on an
// invite opened on a phone, the app in Settings > Sessions and the instance's QR code.

vi.mock('../src/api/app.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/app.ts')>()),
  openInApp: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(openInApp).mockClear();
});

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const QUERY = new URLSearchParams({
  client: 'openlive-mobile',
  redirect_uri: 'openlive://auth',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: '123',
  device_name: 'Pixel 9',
}).toString();
const AUTHORIZE = `/app/authorize?${QUERY}`;
const ANDROID =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36';

describe('/app/authorize', () => {
  it('asks to allow the app, then hands the code to openlive://auth', async () => {
    const calls = fakeApi({
      'GET /api/me': signedIn(),
      'POST /api/app/authorize': () =>
        Response.json({ redirectTo: 'openlive://auth?code=c0de&state=123' }),
    });
    renderApp(AUTHORIZE);
    expect(
      await screen.findByText(/Allow “Openlive” on Pixel 9 to use your account on/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(openInApp).toHaveBeenCalledWith('openlive://auth?code=c0de&state=123'),
    );
    // The state goes as the app sent it, though it looks like a number.
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      client: 'openlive-mobile',
      redirectUri: 'openlive://auth',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: '123',
      deviceName: 'Pixel 9',
    });
    expect(
      await screen.findByText('Go back to the Openlive app. You can close this page.'),
    ).toBeInTheDocument();
  });

  it('denies with access_denied and the state, asking the API nothing', async () => {
    const calls = fakeApi({ 'GET /api/me': signedIn() });
    renderApp(AUTHORIZE);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(openInApp).toHaveBeenCalledWith('openlive://auth?error=access_denied&state=123');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses a request that is not exactly the app, without redirecting', async () => {
    fakeApi({ 'GET /api/me': signedIn() });
    for (const [key, value] of [
      ['redirect_uri', 'https://evil.example/cb'],
      ['client', 'other'],
      ['code_challenge_method', 'plain'],
      ['state', ''],
    ]) {
      const query = new URLSearchParams(QUERY);
      query.set(key as string, value as string);
      renderApp(`/app/authorize?${query}`);
      expect(
        await screen.findByRole('heading', { name: 'This sign-in request is not valid' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
      document.body.innerHTML = '';
    }
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('keeps the whole request through the login', async () => {
    fakeApi({ 'GET /api/health': health, 'GET /api/me': anonymous });
    const router = renderApp(AUTHORIZE);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const link = await screen.findByRole('link', { name: 'Continue with Discord' });
    const returnTo = new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get(
      'returnTo',
    );
    expect(returnTo).toBe(AUTHORIZE);
  });
});

describe('Open in app', () => {
  const TOKEN = 'a'.repeat(43);
  const invite = () =>
    Response.json({
      invite: {
        spaceName: 'Friends',
        roomName: null,
        role: 'member',
        canStream: false,
        requiresApproval: false,
        expiresAt: Date.UTC(2026, 10, 3, 12),
      },
      pending: false,
    });

  it('offers openlive://join on a phone, next to the web flow', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
    fakeApi({ 'GET /api/me': signedIn(), [`GET /api/invites/${TOKEN}`]: invite });
    renderApp(`/invite/${TOKEN}`);
    const open = await screen.findByRole('link', { name: 'Open in app' });
    const href = new URL(open.getAttribute('href') ?? '');
    expect(href.protocol).toBe('openlive:');
    expect(href.host).toBe('join');
    expect(href.searchParams.get('instance')).toBe(window.location.origin);
    expect(href.searchParams.get('invite')).toBe(TOKEN);
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
    // No store links until the app is published.
    expect(screen.queryByRole('link', { name: /Get the app/ })).not.toBeInTheDocument();
  });

  it('also offers it before signing in', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
    fakeApi({
      'GET /api/health': health,
      'GET /api/me': anonymous,
      'GET /api/auth/policy': () => Response.json({ signup: 'open' }),
    });
    renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByRole('link', { name: 'Open in app' })).toBeInTheDocument();
  });

  it('is not shown on a computer', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
    );
    fakeApi({ 'GET /api/me': signedIn(), [`GET /api/invites/${TOKEN}`]: invite });
    renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByText('Join Friends')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in app' })).not.toBeInTheDocument();
  });
});

describe('Settings', () => {
  it('lists the app as a session and revokes it', async () => {
    let sessions = [
      {
        id: 'at_1',
        kind: 'app',
        createdAt: Date.UTC(2026, 9, 20, 9),
        deviceName: 'Pixel 9',
        lastUsedAt: Date.UTC(2026, 9, 27, 12),
        current: false,
      },
    ];
    const calls = fakeApi({
      'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
      'GET /api/me/sessions': () => Response.json({ sessions }),
      'GET /api/me/devices': () => Response.json({ devices: [] }),
      'DELETE /api/me/sessions/at_1': () => {
        sessions = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp('/settings');
    expect(await screen.findByText('Openlive app · Pixel 9')).toBeInTheDocument();
    expect(screen.getByText(/^Last used/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke the session on Openlive app · Pixel 9' }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Openlive app · Pixel 9')).not.toBeInTheDocument(),
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('shows the instance address as a QR code for the app', async () => {
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/me/sessions': () => Response.json({ sessions: [] }),
      'GET /api/me/devices': () => Response.json({ devices: [] }),
    });
    renderApp('/settings');
    expect(
      await screen.findByRole('img', { name: `QR code of ${window.location.origin}` }),
    ).toBeInTheDocument();
  });
});
