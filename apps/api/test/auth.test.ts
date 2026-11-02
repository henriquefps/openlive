// SPDX-License-Identifier: AGPL-3.0-only
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCORD_TOKEN_URL, DISCORD_USER_URL } from '../src/auth/discord';
import { ResendEmailSender, setEmailSenderForTests } from '../src/auth/email';
import { sha256Hex } from '../src/db/util';
import worker from '../src/index';
import { DEV_USER_HEADER } from '../src/room/identity';
import { type Json, migrate, newUser } from './api-helpers';
import {
  discordLogin,
  discordUser,
  FakeSender,
  json,
  location,
  newEmail,
  ORIGIN,
  send,
  setCookies,
  verify,
} from './auth-helpers';

// Login, sessions and the security checks around them. Sign-up is open here
// (api-helpers' migrate); test/signup-policy.test.ts covers the invite-only mode.

beforeAll(migrate);

let mail: FakeSender;
beforeEach(() => {
  mail = new FakeSender();
  setEmailSenderForTests(mail);
});
afterEach(() => {
  setEmailSenderForTests(null);
  vi.restoreAllMocks();
});

/** Signs in through the magic link; returns the session cookie value. */
async function loginByEmail(email: string, origin = ORIGIN): Promise<string> {
  const start = await send('/api/auth/email/start', {
    method: 'POST',
    body: { email },
    origin,
  });
  expect(start.status).toBe(202);
  const res = await verify(mail.lastToken(), { origin });
  expect(res.status).toBe(303);
  const name = origin.startsWith('https:') ? '__Host-ol_session' : 'ol_session';
  const session = setCookies(res)[name];
  if (!session) throw new Error('no session cookie');
  return session.value;
}

const me = (session: string) => send('/api/me', { cookies: { '__Host-ol_session': session } });

describe('Discord login', () => {
  it('redirects to Discord with PKCE S256, state, the scopes and an allow-listed redirect URI', async () => {
    const res = await send('/api/auth/discord/start?returnTo=/s/friends');
    expect(res.status).toBe(302);
    const url = location(res);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('identify email');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);

    const cookie = setCookies(res)['__Host-ol_oauth'];
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=600', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    // The verifier is in a signed cookie, never in the URL.
    expect(url.toString()).not.toContain('verifier');
  });

  it('builds the dev redirect URI on localhost, without Secure', async () => {
    const res = await send('/api/auth/discord/start', { origin: 'http://localhost:5179' });
    expect(location(res).searchParams.get('redirect_uri')).toBe(
      'http://localhost:5179/api/auth/discord/callback',
    );
    expect(setCookies(res)['ol_oauth']?.attributes).not.toContain('Secure');
  });

  it('refuses an origin that is not on the allow-list (Host is not trusted)', async () => {
    for (const origin of ['https://evil.example', 'https://openlive.example.evil.example']) {
      const res = await send('/api/auth/discord/start', { origin });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'origin_not_allowed' });
    }
    // A loopback Host from a remote client (a forged Host on the deployed Worker) is refused.
    const res = await send('/api/auth/discord/start', {
      origin: 'http://localhost:5179',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    expect(res.status).toBe(403);
  });

  it('sends the browser back with auth_not_configured when Discord is not set up', async () => {
    const res = await send('/api/auth/discord/start', { env: { DISCORD_CLIENT_ID: undefined } });
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=auth_not_configured`);
  });

  it('creates an account and a session for a new Discord user', async () => {
    const user = discordUser({ global_name: 'Bia' });
    const { res, calls } = await discordLogin(user, { returnTo: '/s/friends' });
    expect(res.status).toBe(302);
    expect(location(res).toString()).toBe(`${ORIGIN}/s/friends`);
    // PKCE: the token request carried the verifier (the mock checked it against the challenge).
    expect(calls.map((c) => c.url)).toEqual([DISCORD_TOKEN_URL, DISCORD_USER_URL]);
    expect(calls[0]?.body?.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);

    const cookies = setCookies(res);
    const session = cookies['__Host-ol_session'];
    expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=2592000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    // The single-use state cookie is cleared.
    expect(cookies['__Host-ol_oauth']?.attributes).toContain('Max-Age=0');

    const body = await json(await me(session?.value ?? ''));
    expect(body.user).toMatchObject({
      displayName: 'Bia',
      avatarUrl: `https://cdn.discordapp.com/avatars/${user.id}/a1b2c3.png?size=128`,
      isPlatformAdmin: false,
    });
    // D1 holds the SHA-256 of the cookie, never the cookie itself.
    const row = await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?')
      .bind(body.user.id)
      .first<{ id: string }>();
    expect(row?.id).toBe(await sha256Hex(session?.value ?? ''));
  });

  it('keeps a photo chosen in Settings on later Discord logins', async () => {
    const user = discordUser();
    const first = await discordLogin(user);
    const session = setCookies(first.res)['__Host-ol_session']?.value ?? '';
    const { user: me1 } = await json(await me(session));
    const discordPhoto = `https://cdn.discordapp.com/avatars/${user.id}/a1b2c3.png?size=128`;
    expect(me1.avatarUrl).toBe(discordPhoto);
    // Removed in Settings: the next login records the new Discord photo but shows initials.
    const removed = await send('/api/me/avatar', {
      method: 'DELETE',
      cookies: { '__Host-ol_session': session },
    });
    expect(removed.status).toBe(200);
    vi.restoreAllMocks();
    const second = await discordLogin({ ...user, avatar: 'd4e5f6' });
    const body = await json(await me(setCookies(second.res)['__Host-ol_session']?.value ?? ''));
    expect(body.user.avatarUrl).toBeNull();
    expect(body.avatar).toEqual({ source: 'none', discordAvailable: true });
    const row = await env.DB.prepare('SELECT discord_avatar_url FROM users WHERE id = ?')
      .bind(me1.id)
      .first<{ discord_avatar_url: string }>();
    expect(row?.discord_avatar_url).toBe(
      `https://cdn.discordapp.com/avatars/${user.id}/d4e5f6.png?size=128`,
    );
  });

  it('signs the same Discord account into the same user', async () => {
    const user = discordUser();
    const first = await discordLogin(user);
    const second = await discordLogin(user);
    const a = await json(await me(setCookies(first.res)['__Host-ol_session']?.value ?? ''));
    const b = await json(await me(setCookies(second.res)['__Host-ol_session']?.value ?? ''));
    expect(a.user.id).toBe(b.user.id);
  });

  it('rejects a state mismatch or a missing state cookie without calling Discord', async () => {
    const { res, calls } = await discordLogin(discordUser(), { tamperState: true });
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=oauth_state_invalid`);
    expect(calls).toEqual([]);
    expect(setCookies(res)['__Host-ol_session']).toBeUndefined();

    const noCookie = await send('/api/auth/discord/callback?code=good-code&state=abc');
    expect(location(noCookie).toString()).toBe(`${ORIGIN}/?authError=oauth_state_invalid`);
  });

  it('rejects a tampered state cookie', async () => {
    const start = await send('/api/auth/discord/start');
    const state = location(start).searchParams.get('state');
    // Same payload, a signature that is not the Worker's.
    const value = decodeURIComponent(setCookies(start)['__Host-ol_oauth']?.value ?? '');
    const payload = value.slice(0, value.lastIndexOf('.'));
    const forged = encodeURIComponent(`${payload}.${btoa('x'.repeat(32))}`);
    const res = await send(`/api/auth/discord/callback?code=good-code&state=${state}`, {
      cookies: { '__Host-ol_oauth': forged },
    });
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=oauth_state_invalid`);
  });

  it('fails with oauth_failed when Discord refuses the code (PKCE or code mismatch)', async () => {
    const { res, calls } = await discordLogin(discordUser(), { code: 'stolen-code' });
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=oauth_failed`);
    expect(calls).toHaveLength(1);
    expect(setCookies(res)['__Host-ol_session']).toBeUndefined();
  });

  it('fails with oauth_failed when the person cancels on Discord', async () => {
    const start = await send('/api/auth/discord/start');
    const state = location(start).searchParams.get('state');
    const res = await send(`/api/auth/discord/callback?error=access_denied&state=${state}`, {
      cookies: { '__Host-ol_oauth': setCookies(start)['__Host-ol_oauth']?.value ?? '' },
    });
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=oauth_failed`);
  });

  it('offers to link, never links silently, when the verified e-mail has an account', async () => {
    const email = newEmail();
    const session = await loginByEmail(email);
    const existing = (await json(await me(session))).user.id as string;

    const user = discordUser({ email: email.toUpperCase(), verified: true });
    const { res } = await discordLogin(user);
    expect(location(res).toString()).toBe(`${ORIGIN}/?auth=link_offer`);
    expect(setCookies(res)['__Host-ol_session']).toBeUndefined();
    const link = setCookies(res)['__Host-ol_link'];
    expect(link?.attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Path=/']));
    const identities = await env.DB.prepare(
      "SELECT count(*) AS n FROM identities WHERE provider = 'discord' AND provider_user_id = ?",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(identities?.n).toBe(0);

    // Proving the e-mail joins the two.
    const start = await send('/api/auth/email/start', {
      method: 'POST',
      body: { link: true },
      cookies: { '__Host-ol_link': link?.value ?? '' },
    });
    expect(start.status).toBe(202);
    expect(mail.sent.at(-1)?.to).toBe(email);
    expect(mail.sent.at(-1)?.text).toContain('connect your Discord account');
    const verified = await verify(mail.lastToken(), {
      cookies: { '__Host-ol_link': link?.value ?? '' },
    });
    expect(verified.status).toBe(303);
    expect(setCookies(verified)['__Host-ol_link']?.attributes).toContain('Max-Age=0');

    const again = await discordLogin(user);
    const body = await json(await me(setCookies(again.res)['__Host-ol_session']?.value ?? ''));
    expect(body.user.id).toBe(existing);
  });

  it('does not link on an unverified Discord e-mail', async () => {
    const email = newEmail();
    const existing = (await json(await me(await loginByEmail(email)))).user.id;
    const { res } = await discordLogin(discordUser({ email, verified: false }));
    const body = await json(await me(setCookies(res)['__Host-ol_session']?.value ?? ''));
    expect(body.user.id).not.toBe(existing);
  });

  it('refuses { link: true } without a pending link', async () => {
    const res = await send('/api/auth/email/start', { method: 'POST', body: { link: true } });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ code: 'oauth_state_invalid' });
  });
});

// --- Magic link ----------------------------------------------------------------------------

describe('e-mail magic link', () => {
  it('sends a link that signs in once and lands on returnTo', async () => {
    const email = newEmail();
    const start = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: `  ${email.toUpperCase()} `, returnTo: '/s/friends' },
    });
    expect(start.status).toBe(202);
    expect(await json(start)).toEqual({ sent: true });
    const message = mail.sent.at(-1);
    expect(message?.to).toBe(email);
    expect(message?.subject).toBe('Your Openlive sign-in link');
    // The link opens the app's confirmation page; the e-mail never links to the API.
    expect(message?.text).toContain(`${ORIGIN}/login/verify?token=`);
    expect(message?.html).toContain('href="https://openlive.example/login/verify?token=');

    const token = mail.lastToken();
    const row = await env.DB.prepare('SELECT email FROM email_tokens WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .first<{ email: string }>();
    expect(row?.email).toBe(email);

    const first = await verify(token);
    expect(location(first).toString()).toBe(`${ORIGIN}/s/friends`);
    const session = setCookies(first)['__Host-ol_session']?.value ?? '';
    expect((await json(await me(session))).user.displayName).toBe(email.split('@')[0]);

    const second = await verify(token);
    expect(location(second).toString()).toBe(`${ORIGIN}/?authError=magic_link_invalid`);
    expect(setCookies(second)['__Host-ol_session']).toBeUndefined();
  });

  it('a GET (a mail scanner following the link) never uses it: it opens the confirmation page', async () => {
    await send('/api/auth/email/start', { method: 'POST', body: { email: newEmail() } });
    const token = mail.lastToken();
    for (let i = 0; i < 2; i++) {
      const res = await send(`/api/auth/email/verify?token=${token}`);
      expect(res.status).toBe(302);
      expect(location(res).toString()).toBe(`${ORIGIN}/login/verify?token=${token}`);
      expect(setCookies(res)['__Host-ol_session']).toBeUndefined();
    }
    const row = await env.DB.prepare('SELECT used_at FROM email_tokens WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .first<{ used_at: number | null }>();
    expect(row?.used_at).toBeNull();
    expect((await verify(token)).status).toBe(303);
  });

  it('accepts the confirmation as a plain form post and answers 303', async () => {
    await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail(), returnTo: '/spaces' },
    });
    const request = new Request(`${ORIGIN}/api/auth/email/verify`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: mail.lastToken() }),
      redirect: 'manual',
    });
    const res = await worker.fetch(request, env, createExecutionContext());
    expect(res.status).toBe(303);
    expect(location(res).toString()).toBe(`${ORIGIN}/spaces`);
    expect(setCookies(res)['__Host-ol_session']?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a confirmation posted from another origin', async () => {
    await send('/api/auth/email/start', { method: 'POST', body: { email: newEmail() } });
    const res = await verify(mail.lastToken(), { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'origin_not_allowed' });
  });

  it('refuses an expired link', async () => {
    await send('/api/auth/email/start', { method: 'POST', body: { email: newEmail() } });
    const token = mail.lastToken();
    await env.DB.prepare('UPDATE email_tokens SET expires_at = ? WHERE token_hash = ?')
      .bind(Date.now() - 1, await sha256Hex(token))
      .run();
    const res = await verify(token);
    expect(location(res).toString()).toBe(`${ORIGIN}/?authError=magic_link_invalid`);
  });

  it('expires links after 15 minutes', async () => {
    const before = Date.now();
    await send('/api/auth/email/start', { method: 'POST', body: { email: newEmail() } });
    const row = await env.DB.prepare('SELECT expires_at FROM email_tokens WHERE token_hash = ?')
      .bind(await sha256Hex(mail.lastToken()))
      .first<{ expires_at: number }>();
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });

  it('refuses malformed and unknown tokens', async () => {
    for (const token of ['', 'short', 'x'.repeat(43)]) {
      const res = await verify(token);
      expect(location(res).toString()).toBe(`${ORIGIN}/?authError=magic_link_invalid`);
    }
  });

  it('answers the same for known and unknown addresses', async () => {
    const known = newEmail();
    await loginByEmail(known);
    const a = await send('/api/auth/email/start', { method: 'POST', body: { email: known } });
    const b = await send('/api/auth/email/start', { method: 'POST', body: { email: newEmail() } });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it('rate-limits per address', async () => {
    const email = newEmail();
    for (let i = 0; i < 3; i++) {
      const res = await send('/api/auth/email/start', { method: 'POST', body: { email } });
      expect(res.status).toBe(202);
    }
    const res = await send('/api/auth/email/start', { method: 'POST', body: { email } });
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(mail.sent).toHaveLength(3);
  });

  it('counts concurrent sends atomically: never more than the limit get through', async () => {
    const email = newEmail();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        send('/api/auth/email/start', { method: 'POST', body: { email } }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 202)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(mail.sent).toHaveLength(3);
  });

  it('rate-limits per IP across addresses', async () => {
    const headers = { 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 250)}` };
    for (let i = 0; i < 10; i++) {
      const res = await send('/api/auth/email/start', {
        method: 'POST',
        body: { email: newEmail() },
        headers,
      });
      expect(res.status).toBe(202);
    }
    const res = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      headers,
    });
    expect(res.status).toBe(429);
    // Another IP is not affected.
    const other = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      headers: { 'CF-Connecting-IP': '192.0.2.77' },
    });
    expect(other.status).toBe(202);
  });

  it('writes the e-mail in pt-BR from the interface or browser language', async () => {
    await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail(), locale: 'pt-BR' },
    });
    expect(mail.sent.at(-1)?.subject).toBe('Seu link de acesso ao Openlive');
    await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      headers: { 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5' },
    });
    expect(mail.sent.at(-1)?.html).toContain('lang="pt-BR"');
    expect(mail.sent.at(-1)?.text).toContain('expira em 15 minutos');
  });

  it('prefers the saved profile language for a known address', async () => {
    const email = newEmail();
    const session = await loginByEmail(email);
    await send('/api/me', {
      method: 'PUT',
      body: { locale: 'pt-BR' },
      cookies: { '__Host-ol_session': session },
    });
    await send('/api/auth/email/start', { method: 'POST', body: { email, locale: 'en' } });
    expect(mail.sent.at(-1)?.subject).toBe('Seu link de acesso ao Openlive');
  });

  it('validates the body', async () => {
    for (const body of [{ email: 'not-an-email' }, {}, { email: newEmail(), extra: 1 }]) {
      const res = await send('/api/auth/email/start', { method: 'POST', body });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('invalid_message');
    }
  });

  it('answers auth_not_configured without an e-mail provider', async () => {
    setEmailSenderForTests(null);
    const res = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      env: { RESEND_API_KEY: undefined },
    });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ code: 'auth_not_configured' });
  });

  it('sends through Resend with the API key and sender, and reports a refusal', async () => {
    setEmailSenderForTests(null);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    let status = 200;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ id: 'email_1' }, { status });
    });
    const email = newEmail();
    const resendEnv = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Test <login@example.com>' };
    const ok = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email },
      env: resendEnv,
    });
    expect(ok.status).toBe(202);
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer re_test_key');
    const payload = JSON.parse(String(requests[0]?.init?.body));
    expect(payload).toMatchObject({
      from: 'Test <login@example.com>',
      to: [email],
      subject: 'Your Openlive sign-in link',
    });
    expect(payload.text).toContain('/login/verify?token=');

    status = 422;
    const failed = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      env: resendEnv,
    });
    expect(failed.status).toBe(502);
    expect(await json(failed)).toEqual({ code: 'email_send_failed' });
  });

  it('ResendEmailSender throws on a non-2xx answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      new ResendEmailSender('key', 'a@b.c').send({
        to: 'x@y.z',
        subject: 's',
        text: 't',
        html: 'h',
      }),
    ).rejects.toThrow('Resend answered 401');
  });
});

// --- Sessions ------------------------------------------------------------------------------

describe('sessions', () => {
  it('logs out: revokes the session and clears the cookie', async () => {
    const session = await loginByEmail(newEmail());
    expect((await me(session)).status).toBe(200);
    const res = await send('/api/auth/logout', {
      method: 'POST',
      cookies: { '__Host-ol_session': session },
    });
    expect(res.status).toBe(204);
    expect(setCookies(res)['__Host-ol_session']?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    expect((await me(session)).status).toBe(401);
  });

  it('lists the caller sessions and revokes another one', async () => {
    const email = newEmail();
    const laptop = await loginByEmail(email);
    const phone = await loginByEmail(email);
    const list = await json(
      await send('/api/me/sessions', { cookies: { '__Host-ol_session': laptop } }),
    );
    expect(list.sessions).toHaveLength(2);
    const current = list.sessions.find((s: Json) => s.current);
    const other = list.sessions.find((s: Json) => !s.current);
    expect(current.id).toBe(await sha256Hex(laptop));
    expect(other.id).toBe(await sha256Hex(phone));
    expect(Object.keys(current).sort()).toEqual(
      ['createdAt', 'current', 'expiresAt', 'id', 'kind', 'userAgent'].sort(),
    );

    const revoke = await send(`/api/me/sessions/${other.id}`, {
      method: 'DELETE',
      cookies: { '__Host-ol_session': laptop },
    });
    expect(revoke.status).toBe(204);
    expect(setCookies(revoke)['__Host-ol_session']).toBeUndefined();
    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(200);
  });

  it('cannot revoke someone else session', async () => {
    const mine = await loginByEmail(newEmail());
    const theirs = await loginByEmail(newEmail());
    const res = await send(`/api/me/sessions/${await sha256Hex(theirs)}`, {
      method: 'DELETE',
      cookies: { '__Host-ol_session': mine },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe('session_not_found');
    expect((await me(theirs)).status).toBe(200);
  });

  it('revoking the current session clears the cookie', async () => {
    const session = await loginByEmail(newEmail());
    const res = await send(`/api/me/sessions/${await sha256Hex(session)}`, {
      method: 'DELETE',
      cookies: { '__Host-ol_session': session },
    });
    expect(res.status).toBe(204);
    expect(setCookies(res)['__Host-ol_session']?.attributes).toContain('Max-Age=0');
  });

  it('drops Secure only for http://localhost', async () => {
    const session = await loginByEmail(newEmail(), 'http://localhost:5179');
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const start = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      origin: 'http://localhost:5179',
    });
    expect(start.status).toBe(202);
    const res = await verify(mail.lastToken(), {
      origin: 'http://localhost:5179',
    });
    const cookie = setCookies(res)['ol_session'];
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
    expect(cookie?.attributes).not.toContain('Secure');
  });

  it('sets the session cookie as __Host-ol_session on https: Secure, Path=/, no Domain', async () => {
    const start = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
    });
    expect(start.status).toBe(202);
    const cookies = setCookies(await verify(mail.lastToken()));
    expect(cookies['ol_session']).toBeUndefined();
    const cookie = cookies['__Host-ol_session'];
    expect(cookie?.attributes).toEqual(expect.arrayContaining(['Secure', 'Path=/', 'HttpOnly']));
    expect(cookie?.raw).not.toMatch(/Domain=/i);
  });

  it('moves a session issued before __Host- to the new name without signing out', async () => {
    const session = await loginByEmail(newEmail());
    const oldId = await sha256Hex(session);
    // As if issued by the previous Worker (migrations/0013_host_cookie.sql).
    await env.DB.prepare('UPDATE sessions SET legacy_cookie = 1 WHERE id = ?').bind(oldId).run();

    const res = await send('/api/me', { cookies: { ol_session: session } });
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    const moved = cookies['__Host-ol_session']?.value ?? '';
    expect(moved).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(moved).not.toBe(session);
    expect(cookies['__Host-ol_session']?.attributes).toContain('Max-Age=2592000');
    // The old cookie is cleared with the attributes it was set with (Path=/, no Domain).
    expect(cookies['ol_session']?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/']),
    );
    const row = await env.DB.prepare('SELECT legacy_cookie, replaced_by FROM sessions WHERE id = ?')
      .bind(await sha256Hex(moved))
      .first<{ legacy_cookie: number; replaced_by: string | null }>();
    expect(row).toEqual({ legacy_cookie: 0, replaced_by: null });
    expect((await me(moved)).status).toBe(200);
    // The new session never works under the old name.
    expect((await send('/api/me', { cookies: { ol_session: moved } })).status).toBe(401);
  });

  it('refuses a session issued with __Host- under the old name (a planted cookie)', async () => {
    const session = await loginByEmail(newEmail());
    const res = await send('/api/me', { cookies: { ol_session: session } });
    expect(res.status).toBe(401);
    // The __Host- cookie wins when a sibling subdomain planted an old-name one next to it.
    const other = await loginByEmail(newEmail());
    const both = await send('/api/me', {
      cookies: { ol_session: other, '__Host-ol_session': session },
    });
    expect(both.status).toBe(200);
    expect((await json(both)).user.id).toBe((await json(await me(session))).user.id);
  });

  it('logs out a session that still has the old cookie name, clearing both names', async () => {
    const session = await loginByEmail(newEmail());
    await env.DB.prepare('UPDATE sessions SET legacy_cookie = 1 WHERE id = ?')
      .bind(await sha256Hex(session))
      .run();
    const res = await send('/api/auth/logout', {
      method: 'POST',
      cookies: { ol_session: session },
    });
    expect(res.status).toBe(204);
    const cookies = setCookies(res);
    expect(cookies['__Host-ol_session']?.attributes).toContain('Max-Age=0');
    expect(cookies['ol_session']?.attributes).toContain('Max-Age=0');
    expect((await send('/api/me', { cookies: { ol_session: session } })).status).toBe(401);
  });

  it('applies the CSRF check to either cookie name', async () => {
    for (const name of ['ol_session', '__Host-ol_session']) {
      const res = await send('/api/auth/logout', {
        method: 'POST',
        noOrigin: true,
        cookies: { [name]: 'x'.repeat(43) },
      });
      expect(res.status).toBe(403);
    }
  });

  it('rotates the session on renewal: new token and id, the old one ends after a grace minute', async () => {
    const session = await loginByEmail(newEmail());
    const oldId = await sha256Hex(session);
    const now = Date.now();
    const created = await env.DB.prepare('SELECT created_at FROM sessions WHERE id = ?')
      .bind(oldId)
      .first<{ created_at: number }>();
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(now + 5 * 24 * 60 * 60 * 1000, oldId)
      .run();

    const res = await me(session);
    expect(res.status).toBe(200);
    const rotated = setCookies(res)['__Host-ol_session']?.value ?? '';
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(session);
    const newId = await sha256Hex(rotated);
    const rows = await env.DB.prepare(
      'SELECT id, created_at, expires_at, replaced_by FROM sessions WHERE id IN (?, ?)',
    )
      .bind(oldId, newId)
      .all<{ id: string; created_at: number; expires_at: number; replaced_by: string | null }>();
    const oldRow = rows.results.find((r) => r.id === oldId);
    const newRow = rows.results.find((r) => r.id === newId);
    expect(oldRow?.replaced_by).toBe(newId);
    expect(oldRow?.expires_at).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(newRow?.replaced_by).toBeNull();
    expect(newRow?.created_at).toBe(created?.created_at);
    expect(newRow?.expires_at).toBeGreaterThan(now + 29 * 24 * 60 * 60 * 1000);

    // A request already in flight with the old cookie still works, and does not rotate again.
    const late = await me(session);
    expect(late.status).toBe(200);
    expect(setCookies(late)['__Host-ol_session']).toBeUndefined();
    // The list shows one session, the new one, as current.
    const list = await json(
      await send('/api/me/sessions', { cookies: { '__Host-ol_session': rotated } }),
    );
    expect(list.sessions.map((s: Json) => [s.id, s.current])).toEqual([[newId, true]]);
    // A fresh session is not rewritten on every request.
    expect(setCookies(await me(rotated))['__Host-ol_session']).toBeUndefined();
    // After the grace minute the old cookie is dead.
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, oldId)
      .run();
    expect((await me(session)).status).toBe(401);
    expect((await me(rotated)).status).toBe(200);
  });

  it('two requests renewing at once rotate the session only once', async () => {
    const session = await loginByEmail(newEmail());
    const oldId = await sha256Hex(session);
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() + 5 * 24 * 60 * 60 * 1000, oldId)
      .run();
    const results = await Promise.all([me(session), me(session), me(session)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const rotated = results.map((r) => setCookies(r)['__Host-ol_session']?.value).filter(Boolean);
    expect(rotated).toHaveLength(1);
    const successors = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE id != ? AND created_at = (SELECT created_at FROM sessions WHERE id = ?) AND user_id = (SELECT user_id FROM sessions WHERE id = ?)',
    )
      .bind(oldId, oldId, oldId)
      .first<{ n: number }>();
    expect(successors?.n).toBe(1);
  });

  it('revoking a rotated session also ends its predecessor in the grace minute', async () => {
    const session = await loginByEmail(newEmail());
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() + 5 * 24 * 60 * 60 * 1000, await sha256Hex(session))
      .run();
    const rotated = setCookies(await me(session))['__Host-ol_session']?.value ?? '';
    const res = await send('/api/auth/logout', {
      method: 'POST',
      cookies: { '__Host-ol_session': rotated },
    });
    expect(res.status).toBe(204);
    expect((await me(rotated)).status).toBe(401);
    expect((await me(session)).status).toBe(401);
  });

  it('logging out with the rotated-out cookie also ends its successor', async () => {
    const session = await loginByEmail(newEmail());
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() + 5 * 24 * 60 * 60 * 1000, await sha256Hex(session))
      .run();
    const rotated = setCookies(await me(session))['__Host-ol_session']?.value ?? '';
    await send('/api/auth/logout', { method: 'POST', cookies: { '__Host-ol_session': session } });
    expect((await me(rotated)).status).toBe(401);
  });

  it('refuses an expired session', async () => {
    const session = await loginByEmail(newEmail());
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, await sha256Hex(session))
      .run();
    expect((await me(session)).status).toBe(401);
  });

  it('PUT /api/me saves the display name and the language', async () => {
    const session = await loginByEmail(newEmail());
    const res = await send('/api/me', {
      method: 'PUT',
      body: { displayName: '  Carla ', locale: 'pt-BR' },
      cookies: { '__Host-ol_session': session },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).user).toMatchObject({ displayName: 'Carla', locale: 'pt-BR' });
    const reset = await send('/api/me', {
      method: 'PUT',
      body: { locale: null },
      cookies: { '__Host-ol_session': session },
    });
    expect((await json(reset)).user).toMatchObject({ displayName: 'Carla', locale: null });
    const bad = await send('/api/me', {
      method: 'PUT',
      body: { locale: 'fr' },
      cookies: { '__Host-ol_session': session },
    });
    expect(bad.status).toBe(400);
  });
});

// --- CSRF and the development identity -----------------------------------------------------

describe('CSRF (Origin check)', () => {
  it('refuses a state-changing request from another origin', async () => {
    const session = await loginByEmail(newEmail());
    const res = await send('/api/auth/logout', {
      method: 'POST',
      cookies: { '__Host-ol_session': session },
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'origin_not_allowed' });
    expect((await me(session)).status).toBe(200);
  });

  it('refuses a cookie-carrying request without Origin, and cross-site fetches', async () => {
    const session = await loginByEmail(newEmail());
    const noOrigin = await send('/api/me', {
      method: 'PUT',
      body: { displayName: 'Mallory' },
      cookies: { '__Host-ol_session': session },
      noOrigin: true,
    });
    expect(noOrigin.status).toBe(403);
    const crossSite = await send('/api/me', {
      method: 'PUT',
      body: { displayName: 'Mallory' },
      cookies: { '__Host-ol_session': session },
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect((await json(await me(session))).user.displayName).not.toBe('Mallory');
  });

  it('refuses a foreign Origin on the room socket', async () => {
    const session = await loginByEmail(newEmail());
    const res = await send('/ws/rooms/r_any', {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
      cookies: { '__Host-ol_session': session },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 'origin_not_allowed' });
  });
});

describe('development identity', () => {
  it('is ignored for a non-localhost request even with DEV_AUTH=1', async () => {
    const user = await newUser('dev');
    const headers = { [DEV_USER_HEADER]: user };
    expect((await send('/api/me', { headers, origin: 'http://localhost' })).status).toBe(200);
    expect((await send('/api/me', { headers })).status).toBe(401);
    const forgedHost = await send('/api/me', {
      headers: { ...headers, 'CF-Connecting-IP': '203.0.113.5' },
      origin: 'http://localhost',
    });
    expect(forgedHost.status).toBe(401);
  });

  it('loses to the session cookie', async () => {
    const session = await loginByEmail(newEmail());
    const other = await newUser('other');
    const res = await send('/api/me', {
      origin: 'http://localhost',
      headers: { [DEV_USER_HEADER]: other },
      cookies: { ol_session: session },
    });
    expect((await json(res)).user.id).not.toBe(other);
  });
});

// --- Platform admin bootstrap --------------------------------------------------------------

describe('POST /api/admin/claim', () => {
  const claim = (session: string, code: string, extra: Partial<Env> = {}) =>
    send('/api/admin/claim', {
      method: 'POST',
      body: { code },
      cookies: { '__Host-ol_session': session },
      env: extra,
    });

  it('needs a signed-in user', async () => {
    const res = await send('/api/admin/claim', { method: 'POST', body: { code: 'x' } });
    expect(res.status).toBe(401);
  });

  it('is unavailable without INSTALL_CODE', async () => {
    const session = await loginByEmail(newEmail());
    for (const INSTALL_CODE of [undefined, '', '  ']) {
      const res = await claim(session, 'anything', { INSTALL_CODE });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'admin_claim_unavailable' });
    }
  });

  it('refuses a wrong code and rate-limits guesses', async () => {
    const session = await loginByEmail(newEmail());
    for (let i = 0; i < 5; i++) {
      const res = await claim(session, `guess-${i}`);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'install_code_invalid' });
    }
    const res = await claim(session, 'test-install-code');
    expect(res.status).toBe(429);
    expect((await json(res)).code).toBe('rate_limited');
  });

  it('makes the first claimant platform admin, once', async () => {
    const first = await loginByEmail(newEmail());
    const res = await claim(first, 'test-install-code');
    expect(res.status).toBe(200);
    expect((await json(res)).user.isPlatformAdmin).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT actor_id FROM audit_log WHERE action = 'platform.admin.claim'",
    ).all<{ actor_id: string }>();
    expect(audit.results).toHaveLength(1);

    const second = await loginByEmail(newEmail());
    const again = await claim(second, 'test-install-code');
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ code: 'admin_already_claimed' });
  });
});
