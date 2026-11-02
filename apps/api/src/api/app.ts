// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AppAuthorizeResponse,
  AppTokenResponse,
  AppWsTicketResponse,
} from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  APP_CLIENT,
  APP_REDIRECT_URI,
  createAppCode,
  createWsTicket,
  exchangeAppCode,
  revokeAppToken,
  WS_TICKET_TTL_MS,
} from '../auth/app-tokens';
import { consume } from '../auth/rate-limit';
import { ipHash } from '../auth/session';
import { getUser } from '../db/users';
import { ApiError } from '../errors';
import { type AppEnv, authenticate, body, type Ctx } from './context';

// The mobile app's login and credentials (docs/PROTOCOL.md 11.6). /app/authorize is a
// web page: the signed-in person allows the app there, and the page asks this API for the code
// and redirects to openlive://auth itself. The app then exchanges the code here, and uses its app
// token as a bearer on the REST API and for WebSocket tickets.

export const app = new Hono<AppEnv>();

const MINUTE = 60 * 1000;
/** Code exchanges per IP: one per login, plus retries. Guessing a 256-bit code is hopeless anyway. */
const EXCHANGES_PER_IP = { max: 20, windowMs: 10 * MINUTE };
/** Approvals per person: one per app login. */
const AUTHORIZE_PER_USER = { max: 20, windowMs: 10 * MINUTE };
/** Unused tickets one app token may hold: a hub, a space and a room socket, with reconnects. */
const LIVE_TICKETS_PER_TOKEN = 20;

/** The S256 challenge of a 32-byte or longer verifier: base64url, 43 characters (RFC 7636). */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** RFC 6749 state: printable ASCII; capped so the request survives the login's returnTo. */
export const STATE = /^[\x21-\x7e]{1,128}$/;
/** Shown on the consent page and in Settings > Sessions. */
export const DEVICE_NAME_MAX = 64;

// Receivers ignore unknown fields (docs/PROTOCOL.md 1): z.object strips them.
const authorizeRequest = z.object({
  client: z.literal(APP_CLIENT),
  redirectUri: z.literal(APP_REDIRECT_URI),
  codeChallenge: z.string().regex(CODE_CHALLENGE),
  codeChallengeMethod: z.literal('S256'),
  state: z.string().regex(STATE),
  deviceName: z.string().trim().min(1).max(DEVICE_NAME_MAX),
});
const tokenRequest = z.object({
  code: z.string().min(1).max(128),
  codeVerifier: z.string().regex(CODE_VERIFIER),
  client: z.string().min(1).max(64),
  redirectUri: z.string().min(1).max(256),
});

async function limit(c: Ctx, bucket: string, l: { max: number; windowMs: number }) {
  const wait = await consume(c.env.DB, [{ bucket, ...l }], Date.now());
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });
}

/** The caller's app token id, refused (403) for a browser session or a device. */
async function requireApp(c: Ctx): Promise<{ userId: string; appTokenId: string }> {
  const { user, appTokenId } = await authenticate(c);
  if (!appTokenId) throw new ApiError(403, 'forbidden');
  return { userId: user.id, appTokenId };
}

/**
 * Revokes an app token and closes everything it has open (error session_expired, close 4001):
 * its hub sockets, then the rooms and spaces the hub remembers it in.
 */
export async function revokeAppAndClose(
  env: Env,
  userId: string,
  appTokenId: string,
): Promise<boolean> {
  if (!(await revokeAppToken(env.DB, userId, appTokenId, Date.now()))) return false;
  const targets = await env.USER_HUB.get(env.USER_HUB.idFromName(userId)).revokeApp(appTokenId);
  await Promise.all(
    targets.map((t) =>
      t.kind === 'room'
        ? env.ROOM.get(env.ROOM.idFromName(t.id)).revokeApp(appTokenId)
        : env.SPACE.get(env.SPACE.idFromName(t.id)).revokeApp(appTokenId),
    ),
  );
  return true;
}

/**
 * POST /api/app/authorize: the signed-in person allowed the app on /app/authorize. Only a browser
 * session may: an app or a helper cannot mint app tokens. Answers where the page sends the
 * browser: openlive://auth with the code and the app's state, and never anywhere else.
 */
app.post('/app/authorize', async (c) => {
  const { user, deviceId, appTokenId } = await authenticate(c);
  if (deviceId || appTokenId) throw new ApiError(403, 'forbidden');
  const input = await body(c, authorizeRequest);
  await limit(c, `app_authorize:${user.id}`, AUTHORIZE_PER_USER);
  const code = await createAppCode(
    c.env.DB,
    user.id,
    {
      client: input.client,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      deviceName: input.deviceName,
    },
    Date.now(),
  );
  const redirectTo = `${APP_REDIRECT_URI}?${new URLSearchParams({ code, state: input.state })}`;
  c.header('Cache-Control', 'no-store');
  return c.json({ redirectTo } satisfies AppAuthorizeResponse);
});

/** POST /api/app/token: the app exchanges its code and PKCE verifier for an app token. */
app.post('/app/token', async (c) => {
  const input = await body(c, tokenRequest);
  const ip = await ipHash(c.req.raw, c.env);
  if (ip) await limit(c, `app_token:${ip}`, EXCHANGES_PER_IP);
  const issued = await exchangeAppCode(c.env.DB, input, Date.now());
  const user = issued ? await getUser(c.env.DB, issued.userId) : null;
  if (!issued || !user) throw new ApiError(400, 'app_code_invalid');
  c.header('Cache-Control', 'no-store');
  return c.json({
    token: issued.token,
    tokenId: issued.tokenId,
    user: {
      userId: user.id,
      displayName: user.displayName,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    },
  } satisfies AppTokenResponse);
});

/** DELETE /api/app/token: the app signs out; its token stops working and its sockets close. */
app.delete('/app/token', async (c) => {
  const { userId, appTokenId } = await requireApp(c);
  await revokeAppAndClose(c.env, userId, appTokenId);
  return c.body(null, 204);
});

/**
 * POST /api/app/ws-ticket: a single-use ticket for one socket upgrade (`?ticket=` on /ws/hub,
 * /ws/spaces/:id or /ws/rooms/:id), valid for a minute. Tickets, not headers: React Native's
 * WebSocket does not send custom headers the same way on every platform.
 */
app.post('/app/ws-ticket', async (c) => {
  const { appTokenId } = await requireApp(c);
  const now = Date.now();
  const live = await c.env.DB.prepare(
    'SELECT count(*) AS n FROM app_ws_tickets WHERE app_token_id = ? AND expires_at > ?',
  )
    .bind(appTokenId, now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= LIVE_TICKETS_PER_TOKEN) {
    throw new ApiError(429, 'rate_limited', { retryAfterMs: WS_TICKET_TTL_MS });
  }
  const ticket = await createWsTicket(c.env.DB, appTokenId, now);
  c.header('Cache-Control', 'no-store');
  return c.json(ticket satisfies AppWsTicketResponse);
});
