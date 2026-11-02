// SPDX-License-Identifier: AGPL-3.0-only
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { pkceChallenge } from '../src/auth/crypto';
import { DISCORD_TOKEN_URL, DISCORD_USER_URL } from '../src/auth/discord';
import type { EmailMessage, EmailSender } from '../src/auth/email';
import worker from '../src/index';
import type { Json } from './api-helpers';

// Login test helpers (test/auth.test.ts, test/signup-policy.test.ts). The Worker is called
// directly (same isolate), so fetch can be replaced: Discord and Resend are never reached.

export const ORIGIN = 'https://openlive.example';

export class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
  lastToken(): string {
    const text = this.sent.at(-1)?.text ?? '';
    const match = /token=([A-Za-z0-9_-]{43})/.exec(text);
    if (!match?.[1]) throw new Error('no magic link in the last e-mail');
    return match[1];
  }
}

export const unique = () => crypto.randomUUID().slice(0, 8);
export const newEmail = () => `person-${unique()}@example.com`;

export interface CallOptions {
  method?: string;
  body?: unknown;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  origin?: string;
  /** Send no Origin header even on a state-changing request. */
  noOrigin?: boolean;
  env?: Partial<Env>;
}

export async function send(path: string, opts: CallOptions = {}): Promise<Response> {
  const origin = opts.origin ?? ORIGIN;
  const method = opts.method ?? 'GET';
  const headers = new Headers(opts.headers);
  if (method !== 'GET' && !opts.noOrigin && !headers.has('Origin')) headers.set('Origin', origin);
  if (opts.cookies) {
    headers.set(
      'Cookie',
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${origin}${path}`, {
    method,
    headers,
    redirect: 'manual',
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return worker.fetch(request, { ...env, ...opts.env }, createExecutionContext());
}

export async function json(res: Response): Promise<Json> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface SetCookie {
  value: string;
  attributes: string[];
  raw: string;
}

export function setCookies(res: Response): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair = '', ...attributes] = raw.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = { value: pair.slice(eq + 1), attributes, raw };
  }
  return out;
}

export function location(res: Response): URL {
  const value = res.headers.get('Location');
  if (!value) throw new Error(`no Location header (status ${res.status})`);
  return new URL(value);
}

/** Confirms a magic link the way the web's confirmation page does: a POST with the token. */
export const verify = (token: string, opts: CallOptions = {}) =>
  send('/api/auth/email/verify', { ...opts, method: 'POST', body: { token } });

// --- Discord -------------------------------------------------------------------------------

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  email?: string | null;
  verified?: boolean;
}

/**
 * Stands in for Discord's token and user endpoints. The token endpoint answers only when the
 * code_verifier hashes to the challenge sent to /authorize, as Discord does.
 */
export function mockDiscord(user: DiscordUser, challenge: () => string | null) {
  const calls: { url: string; body: URLSearchParams | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === DISCORD_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url, body });
      const ok =
        body.get('code') === 'good-code' &&
        (await pkceChallenge(body.get('code_verifier') ?? '')) === challenge();
      return ok
        ? Response.json({ access_token: 'discord-access-token', token_type: 'Bearer' })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (url === DISCORD_USER_URL) {
      calls.push({ url, body: null });
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth !== 'Bearer discord-access-token') return new Response(null, { status: 401 });
      return Response.json(user);
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return calls;
}

/** Runs /start, then the callback as Discord would redirect to it. */
export async function discordLogin(
  user: DiscordUser,
  opts: {
    code?: string;
    tamperState?: boolean;
    returnTo?: string;
    /** The invite token or room code the login starts from (invite-only sign-up). */
    invite?: string;
    roomCode?: string;
    cookies?: Record<string, string>;
  } = {},
) {
  const query = new URLSearchParams();
  if (opts.returnTo) query.set('returnTo', opts.returnTo);
  if (opts.invite) query.set('invite', opts.invite);
  if (opts.roomCode) query.set('code', opts.roomCode);
  const start = await send(`/api/auth/discord/start${query.size ? `?${query}` : ''}`);
  expect(start.status).toBe(302);
  const authorize = location(start);
  const oauth = setCookies(start)['__Host-ol_oauth'];
  if (!oauth) throw new Error('no oauth cookie');
  const calls = mockDiscord(user, () => authorize.searchParams.get('code_challenge'));
  const state = opts.tamperState ? 'not-the-state' : authorize.searchParams.get('state');
  const res = await send(
    `/api/auth/discord/callback?code=${opts.code ?? 'good-code'}&state=${state}`,
    { cookies: { '__Host-ol_oauth': oauth.value, ...opts.cookies } },
  );
  return { start, authorize, oauth, res, calls };
}

export const discordUser = (extra: Partial<DiscordUser> = {}): DiscordUser => ({
  id: String(Math.floor(Math.random() * 1e15)),
  username: `user${unique()}`,
  global_name: 'Ana',
  avatar: 'a1b2c3',
  email: null,
  verified: false,
  ...extra,
});
