// SPDX-License-Identifier: AGPL-3.0-only
import { consumeWsTicket, isAppToken, resolveAppToken } from '../auth/app-tokens';
import { isLocalRequest } from '../auth/origin';
import { readSessionCookie } from '../auth/cookies';
import { resolveDeviceToken } from '../auth/devices';
import { resolveSessionToken } from '../auth/session';

// Who is calling: a bearer token (`Authorization: Bearer`), which is the mobile app's app token
// or a helper's device token, else the session cookie, else the
// development header on localhost, else nobody (fail closed).

export interface Identity {
  userId: string;
  /** Set when the caller authenticated with the session cookie. */
  sessionId?: string;
  /** Set when the caller is a paired helper (device token). */
  deviceId?: string;
  /** Set when the caller is the mobile app (app token or WebSocket ticket). */
  appTokenId?: string;
  /** The session was renewed and rotated: the new cookie value REST responses must send. */
  rotatedToken?: string;
  /** The session came in the pre-__Host- cookie name, which REST responses clear. */
  legacyCookie?: boolean;
}

export interface ResolveOptions {
  /** Renew (and rotate) a session that is due; only for callers that can set the new cookie. */
  renew?: boolean;
}

export type IdentityResolver = (
  request: Request,
  env: Env,
  options?: ResolveOptions,
) => Promise<Identity | null>;

/**
 * Development and test identity: the user id comes from a request header. Honoured only when the
 * DEV_AUTH var is exactly "1" (set in vitest.config.ts and .dev.vars, never in wrangler.jsonc)
 * and the request comes from this machine (origin.ts), so a deployed Worker never trusts it.
 */
export const DEV_USER_HEADER = 'X-Openlive-Dev-User';
/** With DEV_USER_HEADER: act as that user's paired device with this id (helper tests). */
export const DEV_DEVICE_HEADER = 'X-Openlive-Dev-Device';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const resolveIdentity: IdentityResolver = async (request, env, options = {}) => {
  const auth = request.headers.get('Authorization');
  if (auth !== null) {
    // A bearer is an app token or a device token; a wrong one is not retried as a cookie.
    const bearer = /^Bearer (\S+)$/.exec(auth)?.[1];
    if (!bearer) return null;
    return isAppToken(bearer)
      ? resolveAppToken(env.DB, bearer, Date.now())
      : resolveDeviceToken(env.DB, bearer, Date.now());
  }
  const cookie = readSessionCookie(request);
  const session = await resolveSessionToken(env.DB, cookie?.token ?? null, {
    ...options,
    legacy: cookie?.legacy ?? false,
  });
  if (session) {
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      ...(session.rotatedToken ? { rotatedToken: session.rotatedToken } : {}),
      ...(cookie?.legacy ? { legacyCookie: true } : {}),
    };
  }
  if (env.DEV_AUTH === '1' && isLocalRequest(request)) {
    const userId = request.headers.get(DEV_USER_HEADER);
    if (!userId || !ID_PATTERN.test(userId)) return null;
    const deviceId = request.headers.get(DEV_DEVICE_HEADER);
    if (deviceId === null) return { userId };
    return ID_PATTERN.test(deviceId) ? { userId, deviceId } : null;
  }
  return null;
};

/** The query parameter that carries a WebSocket ticket (POST /api/app/ws-ticket). */
export const WS_TICKET_PARAM = 'ticket';

/**
 * Who opens a socket: a single-use ticket in the URL (the mobile app, whose WebSocket cannot
 * reliably send headers), else the same as a REST call. A URL with a ticket is judged by the
 * ticket alone: a used or wrong one is refused, never retried as a cookie.
 */
export const resolveSocketIdentity: IdentityResolver = async (request, env, options) => {
  const ticket = new URL(request.url).searchParams.get(WS_TICKET_PARAM);
  if (ticket !== null) return consumeWsTicket(env.DB, ticket, Date.now());
  return resolveIdentity(request, env, options);
};
