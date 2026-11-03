// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceInfo, ProtocolVersion } from '@openlive/protocol';
import envelope from '@openlive/protocol/schema/envelope.json';

// Which instance the app talks to, and whether it can: GET /.well-known/openlive.json
// (docs/PROTOCOL.md 11.6) names the instance and the protocol range it accepts.

/** The protocol this build speaks, from the schema the generated types come from. */
export const APP_PROTOCOL: ProtocolVersion = envelope['x-openlive'].protocolVersion;

/** The login this app uses; an instance without it cannot be signed in to. */
export const FEATURE_APP_LOGIN = 'app_login';
/** openlive://join links with an invite (the invite page's "Open in app"). */
export const FEATURE_INVITE_DEEP_LINK = 'invite_deep_link';

/**
 * The origin of what someone typed or scanned: `example.com`, `https://example.com/`,
 * `https://example.com/invite/…`. Plain http only for local addresses (a dev instance on the LAN).
 * Null when it is not an address.
 */
export function normalizeInstanceUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.') && !isLocalHost(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local')
  );
}

function isVersion(value: unknown): value is ProtocolVersion {
  const v = value as ProtocolVersion | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isInteger(v.major) &&
    Number.isInteger(v.minor) &&
    v.major >= 0 &&
    v.minor >= 0
  );
}

/** The body of /.well-known/openlive.json when it has every field the app reads, else null. */
export function parseInstanceInfo(body: unknown): InstanceInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const protocol = b.protocol as Record<string, unknown> | undefined;
  if (
    typeof b.name !== 'string' ||
    b.name.trim() === '' ||
    typeof b.version !== 'string' ||
    typeof b.commit !== 'string' ||
    typeof protocol !== 'object' ||
    protocol === null ||
    !isVersion(protocol.min) ||
    !isVersion(protocol.max) ||
    !Array.isArray(b.features) ||
    !b.features.every((f) => typeof f === 'string')
  ) {
    return null;
  }
  const info: InstanceInfo = {
    name: b.name.trim(),
    version: b.version,
    commit: b.commit,
    protocol: { min: protocol.min, max: protocol.max },
    features: b.features as string[],
  };
  if (typeof b.iconUrl === 'string' && /^https?:\/\//.test(b.iconUrl)) info.iconUrl = b.iconUrl;
  return info;
}

export type Compatibility =
  | { ok: true }
  | {
      ok: false;
      /** too_old: the instance must update; too_new: this app must; no_app_login: no app login. */
      reason: 'too_old' | 'too_new' | 'no_app_login';
    };

/**
 * Whether this app can use the instance: its major between the instance's min and max majors
 * (within a major, unknown fields and messages are ignored) and the app login offered.
 */
export function checkCompatibility(
  info: InstanceInfo,
  app: ProtocolVersion = APP_PROTOCOL,
): Compatibility {
  if (app.major > info.protocol.max.major) return { ok: false, reason: 'too_old' };
  if (app.major < info.protocol.min.major) return { ok: false, reason: 'too_new' };
  if (!info.features.includes(FEATURE_APP_LOGIN)) return { ok: false, reason: 'no_app_login' };
  return { ok: true };
}
