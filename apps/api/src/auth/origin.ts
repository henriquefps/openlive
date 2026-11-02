// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import { errorResponse } from '../errors';
import { APP_TOKEN_PREFIX } from './app-tokens';
import { hasSessionCookie } from './cookies';

// Which origins the app answers for. Redirect URIs, magic links and cookies are
// built from the request's own origin, but only when that origin is on the allow-list: the
// APP_ORIGIN var, plus loopback origins for a request that really comes from this machine. The
// Host header alone is never trusted.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1']);

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether the request was made on this machine: a loopback URL and, when Cloudflare (or
 * `wrangler dev`) names the client, a loopback client. A deployed Worker always sees the real
 * client address in CF-Connecting-IP, so this is false in production even with a forged Host.
 */
export function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const ip = request.headers.get('CF-Connecting-IP');
  return ip === null || LOOPBACK_IPS.has(ip);
}

export function configuredOrigins(env: Env): Set<string> {
  const out = new Set<string>();
  for (const part of (env.APP_ORIGIN ?? '').split(',')) {
    const url = parseOrigin(part.trim());
    if (url) out.add(url.origin);
  }
  return out;
}

/** Whether `origin` (an Origin header value or a URL origin) may talk to this app. */
export function isAllowedOrigin(origin: string, request: Request, env: Env): boolean {
  const url = parseOrigin(origin);
  if (!url) return false;
  if (configuredOrigins(env).has(url.origin)) return true;
  return LOOPBACK_HOSTS.has(url.hostname) && isLocalRequest(request);
}

/** The app origin this request was made to, or null when it is not on the allow-list. */
export function appOrigin(request: Request, env: Env): string | null {
  const origin = new URL(request.url).origin;
  return isAllowedOrigin(origin, request, env) ? origin : null;
}

/** Cookies drop `Secure` only on plain-http loopback (local development). */
export function isSecureOrigin(origin: string): boolean {
  const url = new URL(origin);
  return !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether the request carries an app token (only checked for its shape here). */
const hasAppBearer = (request: Request): boolean =>
  request.headers.get('Authorization')?.startsWith(`Bearer ${APP_TOKEN_PREFIX}`) ?? false;

/**
 * CSRF check for every state-changing /api request: the browser's Origin must be the
 * app. A request without Origin is refused when it carries the session cookie (only a browser
 * sends that cookie, and browsers send Origin on these methods); without the cookie there is no
 * ambient credential to abuse, so non-browser clients (the helper, tests) still work.
 */
export const sameOrigin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const request = c.req.raw;
  // The mobile app sends its app token and no browser Origin. A request with a bearer
  // is authenticated by the bearer alone, never by its cookie (room/identity.ts), and no other
  // site can make a browser add an Authorization header (that needs a CORS preflight this app
  // never answers), so there is no ambient credential to forge. A request that also carries the
  // session cookie gets the full check: the app has no cookies, only a browser does.
  if (hasAppBearer(request) && !hasSessionCookie(request)) return next();
  const origin = request.headers.get('Origin');
  const crossSite = request.headers.get('Sec-Fetch-Site') === 'cross-site';
  const ok = origin
    ? !crossSite && isAllowedOrigin(origin, request, c.env)
    : !crossSite && !hasSessionCookie(request);
  if (!ok) return errorResponse(c, 403, 'origin_not_allowed');
  return next();
};
