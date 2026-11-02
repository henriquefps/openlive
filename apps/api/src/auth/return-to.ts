// SPDX-License-Identifier: AGPL-3.0-only
// Where to land after login: a path on this app only, never another site.

export const DEFAULT_RETURN_TO = '/spaces';
/**
 * Long enough for the mobile app's /app/authorize request, whose state, PKCE challenge and device
 * name survive the login round trip. The e-mail token and the Discord cookie hold it.
 */
export const RETURN_TO_MAX = 1024;

/** `value` when it is a same-app path ("/s/friends"), else the default. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > RETURN_TO_MAX) return DEFAULT_RETURN_TO;
  // "//host" and "/\host" are protocol-relative URLs to another site; control characters
  // could split headers or confuse URL parsers.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return DEFAULT_RETURN_TO;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}
