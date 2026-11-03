// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeInstanceUrl } from './instance.ts';
import { APP_REDIRECT_URI, queryOf } from './pkce.ts';

// What opens the app or comes out of the QR scanner:
// - openlive://join?instance=https://…&invite=<token>: an invite's "Open in app" (the invite page
//   builds exactly this link), or openlive://join?instance=… alone;
// - openlive://auth?…: the end of a login, handled by the login itself;
// - from the scanner, also an instance address or an invite page (https://…/invite/<token>).

/** Invite tokens: 32 random bytes in base64url, as /invite/:token. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type AppLink =
  | { kind: 'join'; instance: string; invite?: string }
  | { kind: 'auth'; url: string }
  | { kind: 'unknown' };

export function parseAppLink(url: string): AppLink {
  const text = url.trim();
  if (queryOf(text, APP_REDIRECT_URI)) return { kind: 'auth', url: text };
  const join = queryOf(text, 'openlive://join');
  if (!join) return { kind: 'unknown' };
  const raw = join.get('instance');
  const instance = raw ? normalizeInstanceUrl(raw) : null;
  // Only a full https (or local http) address: a link must not name a bare host.
  if (!instance || !raw || !/^https?:\/\//i.test(raw)) return { kind: 'unknown' };
  const invite = join.get('invite');
  if (invite && INVITE_TOKEN.test(invite)) return { kind: 'join', instance, invite };
  return { kind: 'join', instance };
}

/** A scanned QR code: an app link, an invite page, or an instance address. */
export function parseScanned(text: string): AppLink {
  const link = parseAppLink(text);
  if (link.kind !== 'unknown') return link.kind === 'auth' ? { kind: 'unknown' } : link;
  const instance = normalizeInstanceUrl(text);
  if (!instance) return { kind: 'unknown' };
  const path = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?/i.exec(text.trim())?.[1] ?? '';
  const invite = /^\/invite\/([A-Za-z0-9_-]{43})\/?$/.exec(path)?.[1];
  return invite ? { kind: 'join', instance, invite } : { kind: 'join', instance };
}
