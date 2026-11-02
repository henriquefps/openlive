// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorCode } from '@openlive/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { addIdentity, createUser, userByEmail, userByIdentity } from '../auth/accounts';
import { identityBanned, userBanned } from '../auth/bans';
import {
  clearAuthCookie,
  clearSessionCookie,
  LINK_COOKIE,
  OAUTH_COOKIE,
  readSessionCookie,
  readSignedJsonCookie,
  setSessionCookie,
  setSignedJsonCookie,
} from '../auth/cookies';
import { hmacHex, pkceChallenge, safeEqual } from '../auth/crypto';
import {
  authorizeUrl,
  callbackPath,
  type DiscordProfile,
  exchangeCode,
  fetchProfile,
} from '../auth/discord';
import { acceptLanguages, emailSender, magicLinkMessage, matchEmailLocale } from '../auth/email';
import { appOrigin } from '../auth/origin';
import { consume, type Limit } from '../auth/rate-limit';
import { RETURN_TO_MAX, safeReturnTo } from '../auth/return-to';
import {
  cleanSignupContext,
  instanceClaimable,
  type SignupContext,
  signupContextInput,
  signupDecision,
  storableSignupContext,
} from '../auth/signup';
import {
  createSession,
  ipHash,
  resolveSessionToken,
  revokeSession,
  SESSION_TTL_MS,
} from '../auth/session';
import { accessPolicy } from '../db/platform';
import { getUser } from '../db/users';
import { randomToken, sha256Hex } from '../db/util';
import { ApiError } from '../errors';
import { type AppEnv, body, type Ctx } from './context';

// Login routes. The two GET routes are browser navigations, so they answer with
// redirects back to the app (errors as `?authError=<code>`, translated by the web); the others
// are JSON. Nothing here logs a token, a code or a secret.

export const auth = new Hono<AppEnv>();

const OAUTH_TTL_MS = 10 * 60 * 1000;
const LINK_TTL_MS = 15 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The web page the magic link opens (apps/web), which confirms with a POST to the API. */
const VERIFY_PAGE = '/login/verify';

const PER_ADDRESS: Omit<Limit, 'bucket'> = { max: 3, windowMs: 15 * 60 * 1000 };
const PER_IP: Omit<Limit, 'bucket'> = { max: 10, windowMs: 60 * 60 * 1000 };

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
  /** The invite or room code the login started from, for a new account in invite-only mode. */
  signup?: SignupContext;
}

/** A Discord account waiting to be linked to the existing account that owns its e-mail. */
interface PendingLink {
  discordId: string;
  email: string;
  avatarUrl: string | null;
  returnTo: string;
}

/** The origin this request may build links and cookies for (origin.ts), or 403. */
function originOf(c: Ctx): string {
  const origin = appOrigin(c.req.raw, c.env);
  if (!origin) throw new ApiError(403, 'origin_not_allowed');
  return origin;
}

/** A redirect into the app: 302 for GET navigations, 303 (then GET) after a form POST. */
const backToApp = (c: Ctx, origin: string, path: string) =>
  c.redirect(`${origin}${path}`, c.req.method === 'POST' ? 303 : 302);

const failTo = (c: Ctx, origin: string, code: ErrorCode) =>
  backToApp(c, origin, `/?authError=${code}`);

async function startSession(c: Ctx, origin: string, userId: string, returnTo: string) {
  const { token } = await createSession(c.req.raw, c.env, userId);
  setSessionCookie(c, origin, token, SESSION_TTL_MS);
  return backToApp(c, origin, returnTo);
}

/**
 * GET /api/auth/policy: what the login page needs before anyone is signed in. `signup` is the
 * policy in effect: `open` also while the instance waits for its first admin to claim it.
 */
auth.get('/auth/policy', async (c) => {
  const { signup } = await accessPolicy(c.env.DB);
  const effective = signup === 'open' || (await instanceClaimable(c.env)) ? 'open' : 'invite_only';
  return c.json({ signup: effective });
});

/**
 * GET /api/auth/discord/start?returnTo=/path[&invite=token|&code=OL-…]: sends the browser to
 * Discord. The invite or code rides in the signed state cookie to the callback.
 */
auth.get('/auth/discord/start', async (c) => {
  const origin = originOf(c);
  const { DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET, SESSION_SECRET: secret } = c.env;
  if (!clientId || !DISCORD_CLIENT_SECRET || !secret) {
    return failTo(c, origin, 'auth_not_configured');
  }
  const state = randomToken();
  const verifier = randomToken();
  await setSignedJsonCookie(
    c,
    secret,
    OAUTH_COOKIE,
    origin,
    {
      state,
      verifier,
      returnTo: safeReturnTo(c.req.query('returnTo')),
      signup: cleanSignupContext({ invite: c.req.query('invite'), code: c.req.query('code') }),
    } satisfies OAuthState,
    OAUTH_TTL_MS,
  );
  return c.redirect(
    authorizeUrl({
      clientId,
      redirectUri: `${origin}${callbackPath}`,
      state,
      codeChallenge: await pkceChallenge(verifier),
    }),
    302,
  );
});

/** GET /api/auth/discord/callback?code&state: signs in, creates the account, or offers a link. */
auth.get('/auth/discord/callback', async (c) => {
  const origin = originOf(c);
  const secret = c.env.SESSION_SECRET;
  if (!secret || !c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET) {
    return failTo(c, origin, 'auth_not_configured');
  }
  // The state cookie is single use: cleared whatever happens next.
  const saved = await readSignedJsonCookie<OAuthState>(c, secret, OAUTH_COOKIE, origin);
  clearAuthCookie(c, OAUTH_COOKIE, origin);
  const state = c.req.query('state');
  if (!saved || !state || !(await safeEqual(state, saved.state))) {
    return failTo(c, origin, 'oauth_state_invalid');
  }
  const code = c.req.query('code');
  if (!code || c.req.query('error')) return failTo(c, origin, 'oauth_failed');

  let profile: DiscordProfile;
  try {
    const accessToken = await exchangeCode(c.env, code, saved.verifier, `${origin}${callbackPath}`);
    profile = await fetchProfile(accessToken);
  } catch (err) {
    console.error('discord login failed:', err instanceof Error ? err.message : 'unknown error');
    return failTo(c, origin, 'oauth_failed');
  }

  const db = c.env.DB;
  const known = await userByIdentity(db, 'discord', profile.id);
  // A banned account never signs in, and its Discord account or e-mail never signs up again.
  if (
    known
      ? await userBanned(db, known)
      : await identityBanned(db, { discordId: profile.id, email: profile.verifiedEmail })
  ) {
    return failTo(c, origin, 'account_banned');
  }
  if (known) {
    if (profile.avatarUrl) {
      // A photo the person uploaded or removed in Settings stays; Discord's is remembered for
      // "Use my Discord photo" (migrations/0012_avatars.sql).
      await db
        .prepare(
          `UPDATE users SET discord_avatar_url = ?1,
             avatar_url = CASE WHEN avatar_source IS NULL THEN ?1 ELSE avatar_url END
           WHERE id = ?2`,
        )
        .bind(profile.avatarUrl, known)
        .run();
    }
    return startSession(c, origin, known, saved.returnTo);
  }

  // A verified e-mail that already has an account is never joined silently: the
  // person proves they own that account with a magic link first.
  const email = profile.verifiedEmail;
  const emailOwned = email !== null && (await userByEmail(db, email)) !== null;
  if (!emailOwned) {
    // A new account: only with what the sign-up policy accepts. Nothing is written otherwise.
    const decision = await signupDecision(c.env, saved.signup ?? {});
    if (!decision.allowed) return failTo(c, origin, decision.code);
  }
  const created = emailOwned
    ? null
    : await createUser(
        db,
        { displayName: profile.displayName, avatarUrl: profile.avatarUrl, email, locale: null },
        'discord',
        profile.id,
      );
  if (created) return startSession(c, origin, created, saved.returnTo);
  if (!email) return failTo(c, origin, 'oauth_failed');

  await setSignedJsonCookie(
    c,
    secret,
    LINK_COOKIE,
    origin,
    {
      discordId: profile.id,
      email,
      avatarUrl: profile.avatarUrl,
      returnTo: saved.returnTo,
    } satisfies PendingLink,
    LINK_TTL_MS,
  );
  return backToApp(c, origin, '/?auth=link_offer');
});

const emailStart = z
  .strictObject({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    /** Send the link to the e-mail of the pending Discord link instead. */
    link: z.literal(true).optional(),
    /** The interface language, for the e-mail text. */
    locale: z.string().max(35).optional(),
    returnTo: z.string().max(RETURN_TO_MAX).optional(),
    /** The invite token or room code the login started from (invite-only sign-up). */
    ...signupContextInput,
  })
  .refine((v) => (v.email === undefined) !== (v.link === undefined), { path: ['email'] });

/**
 * POST /api/auth/email/start { email, invite?, code? } | { link: true }: e-mails a magic link. The
 * answer is the same whether or not the address has an account. An unknown address gets an
 * account when the link is used, if the sign-up policy allows it; when it would not, no e-mail is
 * sent at all, and the answer is still the same.
 */
auth.post('/auth/email/start', async (c) => {
  const origin = originOf(c);
  const sender = emailSender(c.env);
  const secret = c.env.SESSION_SECRET;
  if (!sender || !secret) throw new ApiError(503, 'auth_not_configured');
  const input = await body(c, emailStart);

  let email = input.email;
  let returnTo = safeReturnTo(input.returnTo);
  if (input.link) {
    const pending = await readSignedJsonCookie<PendingLink>(c, secret, LINK_COOKIE, origin);
    if (!pending) throw new ApiError(400, 'oauth_state_invalid');
    email = pending.email;
    returnTo = pending.returnTo;
  }
  if (!email) throw new ApiError(400, 'invalid_message', { path: '/email' });

  const db = c.env.DB;
  const now = Date.now();
  const ip = await ipHash(c.req.raw, c.env);
  const limits: Limit[] = [
    { bucket: `email:${await hmacHex(secret, `email:${email}`)}`, ...PER_ADDRESS },
    ...(ip ? [{ bucket: `ip:${ip}`, ...PER_IP }] : []),
  ];
  const wait = await consume(db, limits, now);
  if (wait > 0) throw new ApiError(429, 'rate_limited', { retryAfterMs: wait });

  const ownerId = await userByEmail(db, email);
  const signup = cleanSignupContext(input);
  // A banned address gets the same answer, with nothing sent (the link would be refused anyway).
  if ((ownerId ? await userBanned(db, ownerId) : false) || (await identityBanned(db, { email }))) {
    return c.json({ sent: true }, 202);
  }
  if (!ownerId && !(await signupDecision(c.env, signup, now)).allowed) {
    // Same answer as a sent link, so the response never tells whether the address has an account.
    return c.json({ sent: true }, 202);
  }

  const token = randomToken();
  const purpose = input.link ? 'link' : 'login';
  const stored = await storableSignupContext(signup);
  const context = stored.inviteHash || stored.code ? JSON.stringify(stored) : null;
  await db
    .prepare(
      `INSERT INTO email_tokens (token_hash, email, purpose, expires_at, return_to, created_at,
                                 signup_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(token), email, purpose, now + MAGIC_LINK_TTL_MS, returnTo, now, context)
    .run();

  const owner = ownerId ? await getUser(db, ownerId) : null;
  const locale = matchEmailLocale([
    owner?.locale,
    input.locale,
    ...acceptLanguages(c.req.header('Accept-Language') ?? null),
  ]);
  // The link opens a confirmation page in the app; only its button (a POST) uses the token, so a
  // mail scanner that follows links cannot burn it.
  const url = `${origin}${VERIFY_PAGE}?token=${token}`;
  try {
    await sender.send(magicLinkMessage(email, url, locale, purpose));
  } catch (err) {
    console.error('magic link e-mail failed:', err instanceof Error ? err.message : 'unknown');
    throw new ApiError(502, 'email_send_failed');
  }
  return c.json({ sent: true }, 202);
});

/**
 * GET /api/auth/email/verify?token=: never uses the token. Links sent before the confirmation page
 * existed pointed here, so it forwards them to that page.
 */
auth.get('/auth/email/verify', (c) => {
  const origin = originOf(c);
  const token = c.req.query('token') ?? '';
  if (!TOKEN_PATTERN.test(token)) return failTo(c, origin, 'magic_link_invalid');
  return backToApp(c, origin, `${VERIFY_PAGE}?token=${token}`);
});

function parseSignup(json: string | null): SignupContext {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') return {};
    const { inviteHash, code } = value as Record<string, unknown>;
    return cleanSignupContext({
      inviteHash: typeof inviteHash === 'string' ? inviteHash : undefined,
      code: typeof code === 'string' ? code : undefined,
    });
  } catch {
    return {};
  }
}

/** The token from a form post (the confirmation page's button) or a JSON body. */
async function postedToken(c: Ctx): Promise<string> {
  const type = c.req.header('Content-Type') ?? '';
  try {
    if (type.startsWith('application/json')) {
      const value = ((await c.req.json()) as { token?: unknown } | null)?.token;
      return typeof value === 'string' ? value : '';
    }
    const value = (await c.req.parseBody())['token'];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * POST /api/auth/email/verify (form field or JSON `token`): uses the magic link (once) and signs
 * in. Posted by the confirmation page as a top-level form, so the answer is a 303 redirect.
 */
auth.post('/auth/email/verify', async (c) => {
  const origin = originOf(c);
  const secret = c.env.SESSION_SECRET;
  if (!secret) return failTo(c, origin, 'auth_not_configured');
  const token = await postedToken(c);
  if (!TOKEN_PATTERN.test(token)) return failTo(c, origin, 'magic_link_invalid');

  const db = c.env.DB;
  const now = Date.now();
  // Marking it used and reading it is one statement, so two clicks cannot both sign in.
  const row = await db
    .prepare(
      `UPDATE email_tokens SET used_at = ?1
       WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING email, purpose, return_to, signup_json`,
    )
    .bind(now, await sha256Hex(token))
    .first<{
      email: string;
      purpose: 'login' | 'link';
      return_to: string | null;
      signup_json: string | null;
    }>();
  if (!row) return failTo(c, origin, 'magic_link_invalid');

  const { email } = row;
  let userId = await userByEmail(db, email);
  // Banned since the link was sent: neither the account nor a new one with this address.
  if ((userId ? await userBanned(db, userId) : false) || (await identityBanned(db, { email }))) {
    return failTo(c, origin, 'account_banned');
  }
  if (userId) {
    await addIdentity(db, userId, 'email', email, email);
  } else {
    // The account was not there when the link was sent, or was removed since: the policy is
    // checked again, with the invite the link was sent for.
    const decision = await signupDecision(c.env, parseSignup(row.signup_json), now);
    if (!decision.allowed) return failTo(c, origin, decision.code);
    userId =
      (await createUser(
        db,
        {
          displayName: email.split('@')[0]?.slice(0, 80) || email,
          avatarUrl: null,
          email,
          locale: null,
        },
        'email',
        email,
      )) ?? (await userByEmail(db, email));
    if (!userId) return failTo(c, origin, 'internal_error');
  }

  if (row.purpose === 'link') {
    const pending = await readSignedJsonCookie<PendingLink>(c, secret, LINK_COOKIE, origin);
    clearAuthCookie(c, LINK_COOKIE, origin);
    // Opened in another browser, the link still signs in, but there is no Discord account to join.
    if (pending && pending.email === email) {
      await addIdentity(db, userId, 'discord', pending.discordId, email);
      if (pending.avatarUrl) {
        await db
          .prepare(
            `UPDATE users SET discord_avatar_url = ?1,
               avatar_url = CASE WHEN avatar_url IS NULL AND avatar_source IS NULL THEN ?1
                 ELSE avatar_url END
             WHERE id = ?2`,
          )
          .bind(pending.avatarUrl, userId)
          .run();
      }
    }
  }
  return startSession(c, origin, userId, safeReturnTo(row.return_to));
});

/** POST /api/auth/logout: revokes the current session and clears the cookie. */
auth.post('/auth/logout', async (c) => {
  const origin = originOf(c);
  const cookie = readSessionCookie(c.req.raw);
  const session = await resolveSessionToken(c.env.DB, cookie?.token ?? null, {
    legacy: cookie?.legacy ?? false,
  });
  if (session) await revokeSession(c.env.DB, session.userId, session.sessionId);
  clearSessionCookie(c, origin);
  return c.body(null, 204);
});
