// SPDX-License-Identifier: AGPL-3.0-only
import { base64url, utf8 } from './base64url.ts';

// The app's login (docs/PROTOCOL.md 11.6): PKCE S256 with a random state, in the system browser,
// back to openlive://auth with a one-time code. The crypto comes in as functions, so this module
// runs the same under Hermes (expo-crypto) and in the tests (node:crypto).

export const APP_CLIENT = 'openlive-mobile';
export const APP_REDIRECT_URI = 'openlive://auth';
/** The server's limit on the name the consent page shows. */
export const DEVICE_NAME_MAX = 64;

export interface PkceCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

export interface PkceRequest {
  /** 43 characters of base64url: 32 random bytes (RFC 7636 4.1). */
  verifier: string;
  /** BASE64URL(SHA-256(verifier)). */
  challenge: string;
  /** 22 characters of base64url: 16 random bytes. */
  state: string;
}

export async function codeChallenge(verifier: string, crypto: PkceCrypto): Promise<string> {
  return base64url(await crypto.sha256(utf8(verifier)));
}

export async function createPkce(crypto: PkceCrypto): Promise<PkceRequest> {
  const verifier = base64url(crypto.randomBytes(32));
  return {
    verifier,
    challenge: await codeChallenge(verifier, crypto),
    state: base64url(crypto.randomBytes(16)),
  };
}

/** The name the consent page shows ("Allow 'Openlive' on <device_name>…"), 1–64 characters. */
export function deviceName(modelName: string | null | undefined, fallback: string): string {
  const name = (modelName ?? '').trim() || fallback;
  return [...name].slice(0, DEVICE_NAME_MAX).join('');
}

/** The /app/authorize page of an instance, with every parameter the server checks (and the invite, if any). */
export function authorizeUrl(
  origin: string,
  pkce: PkceRequest,
  device: string,
  invite?: string,
): string {
  const query = new URLSearchParams({
    client: APP_CLIENT,
    redirect_uri: APP_REDIRECT_URI,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    device_name: device,
  });
  // A new person following an invite can sign up on an invite-only instance (PROTOCOL 11.6).
  if (invite) query.set('invite', invite);
  return `${origin}/app/authorize?${query.toString()}`;
}

export type AuthRedirect =
  { ok: true; code: string } | { ok: false; reason: 'denied' | 'state_mismatch' | 'invalid' };

/**
 * Reads openlive://auth?code=…&state=… (or error=access_denied). A state that is not the one this
 * login sent means the redirect did not come from it, so its code is never exchanged.
 */
export function parseAuthRedirect(url: string, expectedState: string): AuthRedirect {
  const query = queryOf(url, APP_REDIRECT_URI);
  if (!query) return { ok: false, reason: 'invalid' };
  if (query.get('state') !== expectedState) return { ok: false, reason: 'state_mismatch' };
  if (query.get('error') === 'access_denied') return { ok: false, reason: 'denied' };
  const code = query.get('code');
  if (!code) return { ok: false, reason: 'invalid' };
  return { ok: true, code };
}

/** The query of a URL that starts with `base` (no other path), or null. */
export function queryOf(url: string, base: string): URLSearchParams | null {
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  // openlive://auth/?code=… is the same link; openlive://authx is not.
  const search = rest.replace(/^\/?/, '');
  if (search !== '' && !search.startsWith('?')) return null;
  return new URLSearchParams(search.replace(/#.*$/, ''));
}
