// SPDX-License-Identifier: AGPL-3.0-only
import type { AppAuthorizeRequest, AppAuthorizeResponse } from '@openlive/protocol';
import { apiSend } from './client.ts';

// The mobile app: the consent page of its login (/app/authorize) and the links that
// open it from the web (an invite's "Open in app"). The API checks every value again; these
// checks only decide what the page shows, and that it never redirects anywhere but the app.

export const APP_CLIENT = 'openlive-mobile';
export const APP_REDIRECT_URI = 'openlive://auth';
/** apps/api/src/api/app.ts */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[\x21-\x7e]{1,128}$/;
const DEVICE_NAME_MAX = 64;

/** The query of /app/authorize, as the app sends it (OAuth's snake_case names). */
export type AppAuthorizeSearch = URLSearchParams;

/**
 * The request when every parameter is valid, else null. A request that fails here is never
 * answered with a redirect (RFC 6749 4.1.2.1): it may not come from the app at all.
 */
export function parseAuthorizeRequest(search: AppAuthorizeSearch): AppAuthorizeRequest | null {
  const codeChallenge = search.get('code_challenge') ?? '';
  const state = search.get('state') ?? '';
  const deviceName = search.get('device_name')?.trim() ?? '';
  if (
    search.get('client') !== APP_CLIENT ||
    search.get('redirect_uri') !== APP_REDIRECT_URI ||
    !CODE_CHALLENGE.test(codeChallenge) ||
    search.get('code_challenge_method') !== 'S256' ||
    !STATE.test(state) ||
    deviceName.length === 0 ||
    deviceName.length > DEVICE_NAME_MAX
  ) {
    return null;
  }
  return {
    client: APP_CLIENT,
    redirectUri: APP_REDIRECT_URI,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state,
    deviceName,
  };
}

/** Allows the app: where to send the browser next (openlive://auth?code=…&state=…). */
export async function authorizeApp(request: AppAuthorizeRequest): Promise<string> {
  const { redirectTo } = await apiSend<AppAuthorizeResponse>('POST', '/api/app/authorize', request);
  return redirectTo;
}

/** Where a refusal sends the browser: back to the app, with RFC 6749's access_denied. */
export function deniedRedirect(state: string): string {
  return `${APP_REDIRECT_URI}?${new URLSearchParams({ error: 'access_denied', state })}`;
}

/** Leaves the page for the app. A custom scheme is not a fetch, so the CSP has no say in it. */
export function openInApp(url: string): void {
  window.location.href = url;
}

/** openlive://join: the app gets this instance and the invite together. */
export function appJoinLink(origin: string, inviteToken: string): string {
  return `openlive://join?${new URLSearchParams({ instance: origin, invite: inviteToken })}`;
}

/** Whether this browser runs on a phone or tablet, where the app may be installed. */
export function isPhone(
  userAgent: string = navigator.userAgent,
  touchPoints: number = navigator.maxTouchPoints,
): boolean {
  // iPadOS Safari says "Macintosh"; a Mac has no touch screen.
  return (
    /Android|iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
  );
}

/**
 * The app's store pages, empty until the app is published. "Get the app" links appear once one
 * is set.
 */
export const APP_STORE_LINKS: { ios?: string; android?: string } = {};
