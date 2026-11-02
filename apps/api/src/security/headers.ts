// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';

// Security headers. One Worker serves everything,
// but in two ways: the web app's files come from Workers Static Assets without running the
// Worker, and get their headers from apps/web/public/_headers; the API, the sockets' refusals and
// the auth redirects come from the Worker, and get theirs from the middleware below. The _headers
// file is rendered from this module (headersFile) and a test checks the two never drift apart.

/**
 * The web app's policy. Scripts only from this origin (the Vite build has no inline script).
 * Styles also inline: Radix (react-style-singleton) and sonner insert <style> elements at run
 * time, and there is no per-response nonce for static files. 'self' in connect-src also covers
 * ws: and wss: to this origin (CSP 3). WebRTC media and TURN are not fetches, so connect-src
 * does not apply to them; every Realtime API call is the Worker's.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Inter is bundled with the app (@fontsource-variable/inter), not loaded from Google Fonts.
  "font-src 'self'",
  // Discord avatars (auth/discord.ts), thumbnails and icons from the API, blob: and data: images.
  "img-src 'self' data: blob: https://cdn.discordapp.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  // The magic link's confirmation page posts a top-level form to /api/auth/email/verify.
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** API responses are data, never a document: nothing may load from them or frame them. */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Powerful features for this origin only; the others off. Camera, microphone and screen capture
 * are the room's; fullscreen, picture-in-picture, wake lock and autoplay the player's; clipboard
 * the invite and code buttons'.
 */
export const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'display-capture=(self)',
  'fullscreen=(self)',
  'autoplay=(self)',
  'picture-in-picture=(self)',
  'screen-wake-lock=(self)',
  'clipboard-write=(self)',
  'accelerometer=()',
  'bluetooth=()',
  'browsing-topics=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'midi=()',
  'payment=()',
  'serial=()',
  'usb=()',
].join(', ');

export const HSTS = 'max-age=31536000; includeSubDomains';

/**
 * Headers every response gets. Referrer-Policy is not no-referrer on purpose: with no-referrer a
 * browser sends `Origin: null` on a form POST, and the CSRF check (auth/origin.ts) would refuse
 * the magic link's confirmation form.
 */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** The static files' headers. HSTS is sent on http too; browsers ignore it there (RFC 6797 8.1). */
export const APP_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': APP_CSP,
  ...COMMON_HEADERS,
  'Strict-Transport-Security': HSTS,
};

/**
 * `no-transform` on HTML documents stops the zone's automatic script injection (Web Analytics'
 * beacon, JavaScript Detections, e-mail obfuscation), which the CSP would block anyway. See
 * docs/self-host.md ("Cloudflare features that inject scripts"). Cloudflare also skips
 * compression and Polish for such responses, which is why the hashed assets do not get it.
 * `no-cache` is the revalidation index.html needs: a new deploy must be seen at once.
 */
export const DOCUMENT_CACHE_CONTROL = 'no-cache, no-transform';

/** The Vite build's content-hashed files: never change under their name, and carry no HTML. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * apps/web/public/_headers, which Workers Static Assets applies to every file it serves. The
 * static host cannot match on content type, so every path gets the document policy and
 * `/assets/*` detaches it (`!`) and sets its own.
 */
export function headersFile(): string {
  const lines = [
    '# SPDX-License-Identifier: AGPL-3.0-only',
    '# Generated from apps/api/src/security/headers.ts (headersFile); edit there, then copy the',
    '# output here. apps/api/test/security-headers.test.ts fails while the two differ.',
    '/*',
    ...Object.entries(APP_HEADERS).map(([name, value]) => `  ${name}: ${value}`),
    `  Cache-Control: ${DOCUMENT_CACHE_CONTROL}`,
    '/assets/*',
    '  ! Cache-Control',
    `  Cache-Control: ${ASSET_CACHE_CONTROL}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Sets the security headers on every Worker response that does not set them itself, plus
 * `Cache-Control: no-store, no-transform` where the route chose no caching: API answers are per
 * person. Any HTML a route sends with its own Cache-Control still gets `no-transform`. A
 * WebSocket handshake (101) is left alone.
 */
export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const https = new URL(c.req.url).protocol === 'https:';
  const wanted: Record<string, string> = {
    'Content-Security-Policy': API_CSP,
    ...COMMON_HEADERS,
    'Cache-Control': 'no-store, no-transform',
    ...(https ? { 'Strict-Transport-Security': HSTS } : {}),
  };
  // A response passed through from fetch() has immutable headers; copy it first.
  let headers = c.res.headers;
  try {
    headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    c.res = new Response(c.res.body, c.res);
    headers = c.res.headers;
  }
  for (const [name, value] of Object.entries(wanted)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  const cacheControl = headers.get('Cache-Control') ?? '';
  if (
    headers.get('Content-Type')?.startsWith('text/html') &&
    !/\bno-transform\b/i.test(cacheControl)
  ) {
    headers.set('Cache-Control', `${cacheControl}${cacheControl ? ', ' : ''}no-transform`);
  }
};
