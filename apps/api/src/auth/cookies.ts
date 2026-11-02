// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { isSecureOrigin } from './origin';
import { readCookie } from './session';

// The login cookies. All are HttpOnly and SameSite=Lax (Lax so that the top-level redirect back
// from Discord or from the e-mail link carries them); Secure everywhere but http://localhost.
//
// On https origins every name has the __Host- prefix (L3): the
// browser then only accepts the cookie from this exact host, with Secure and Path=/, so a
// sibling subdomain of a shared parent domain cannot plant or shadow one. Plain-http localhost
// cannot have Secure cookies, so local development keeps the plain names.

/** The session id: opaque, random, stored in D1 only as its SHA-256. */
export const SESSION_COOKIE = 'ol_session';
/** Discord login in progress: state, PKCE verifier and where to land (signed, 10 minutes). */
export const OAUTH_COOKIE = 'ol_oauth';
/** A Discord account waiting to be linked to an existing account by e-mail (signed, 15 minutes). */
export const LINK_COOKIE = 'ol_link';

const HOST_PREFIX = '__Host-';
/** Where the plain-named login cookies live; __Host- cookies must use Path=/. */
const AUTH_PATH = '/api/auth';

/** The name a cookie has on this origin: __Host-<name> on https, <name> on http localhost. */
export function cookieName(name: string, origin: string): string {
  return isSecureOrigin(origin) ? `${HOST_PREFIX}${name}` : name;
}

function options(origin: string, path: string, maxAgeSeconds: number): CookieOptions {
  const secure = isSecureOrigin(origin);
  return {
    path: secure ? '/' : path,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: maxAgeSeconds,
  };
}

export interface SessionCookie {
  token: string;
  /**
   * The token came in the plain `ol_session` cookie on an https origin, as it was sent before
   * the __Host- prefix: only sessions issued then are accepted that way (session.ts), and the
   * REST API re-issues them under the new name.
   */
  legacy: boolean;
}

/** The session token this request carries, under the name its origin uses (or the old one). */
export function readSessionCookie(request: Request): SessionCookie | null {
  const origin = new URL(request.url).origin;
  const name = cookieName(SESSION_COOKIE, origin);
  const token = readCookie(request, name);
  if (token !== null) return { token, legacy: false };
  if (name === SESSION_COOKIE) return null;
  const legacy = readCookie(request, SESSION_COOKIE);
  return legacy === null ? null : { token: legacy, legacy: true };
}

/** Whether the request carries a session cookie under either name (the CSRF check). */
export function hasSessionCookie(request: Request): boolean {
  const names = [SESSION_COOKIE, `${HOST_PREFIX}${SESSION_COOKIE}`];
  return names.some((name) => readCookie(request, name) !== null);
}

export function setSessionCookie(c: Context, origin: string, token: string, maxAgeMs: number) {
  setCookie(
    c,
    cookieName(SESSION_COOKIE, origin),
    token,
    options(origin, '/', Math.floor(maxAgeMs / 1000)),
  );
}

export function clearSessionCookie(c: Context, origin: string) {
  deleteCookie(c, cookieName(SESSION_COOKIE, origin), options(origin, '/', 0));
  if (isSecureOrigin(origin)) clearLegacySessionCookie(c, origin);
}

/** Removes the pre-__Host- `ol_session` cookie (it was set with Path=/ and no Domain). */
export function clearLegacySessionCookie(c: Context, origin: string) {
  deleteCookie(c, SESSION_COOKIE, { ...options(origin, '/', 0), path: '/' });
}

/** A short-lived signed JSON cookie (under /api/auth on http localhost). */
export async function setSignedJsonCookie(
  c: Context,
  secret: string,
  name: string,
  origin: string,
  value: object,
  maxAgeMs: number,
) {
  const expiresAt = Date.now() + maxAgeMs;
  await setSignedCookie(
    c,
    cookieName(name, origin),
    JSON.stringify({ ...value, exp: expiresAt }),
    secret,
    options(origin, AUTH_PATH, Math.floor(maxAgeMs / 1000)),
  );
}

/**
 * The value of a signed JSON cookie, or null if missing, tampered with or expired. Only the name
 * the origin uses is read: a login started before the __Host- prefix (10 or 15 minutes at most)
 * just has to be started again.
 */
export async function readSignedJsonCookie<T>(
  c: Context,
  secret: string,
  name: string,
  origin: string,
): Promise<T | null> {
  const raw = await getSignedCookie(c, secret, cookieName(name, origin));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as T & { exp?: unknown };
    return typeof value.exp === 'number' && value.exp > Date.now() ? value : null;
  } catch {
    return null;
  }
}

export function clearAuthCookie(c: Context, name: string, origin: string) {
  deleteCookie(c, cookieName(name, origin), options(origin, AUTH_PATH, 0));
}
