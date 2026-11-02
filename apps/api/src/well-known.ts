// SPDX-License-Identifier: AGPL-3.0-only
import { type InstanceInfo, PROTOCOL_VERSION } from '@openlive/protocol';
import type { Context } from 'hono';
import pkg from '../package.json';
import { appOrigin, configuredOrigins } from './auth/origin';
import { platformCapabilities } from './db/platform';
import { CAPABILITIES } from './room/capabilities';

// GET /.well-known/openlive.json (docs/PROTOCOL.md 11.6): what the
// mobile app checks before it connects to an instance, by URL or QR code. Public and the same for
// everyone: no cookie is read and nothing about any person is in it.

/** The oldest protocol the instance's sockets accept (the DOs' MIN_PROTOCOL). */
export const MIN_PROTOCOL = { major: 1, minor: 0 } as const;

/** What the server code offers, whatever the platform settings say. */
const SERVER_FEATURES = ['app_login', 'ws_ticket', 'invite_deep_link'] as const;

/** Shared caches and the app may keep it for five minutes. */
const CACHE_CONTROL = 'public, max-age=300';

export async function wellKnown(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = appOrigin(c.req.raw, c.env) ?? [...configuredOrigins(c.env)][0] ?? null;
  const capabilities = await platformCapabilities(c.env.DB);
  const info: InstanceInfo = {
    // Instances have no name setting yet: the host is what people know them by.
    name: origin ? new URL(origin).hostname : new URL(c.req.url).hostname,
    ...(origin ? { iconUrl: `${origin}/icon-512.png` } : {}),
    version: pkg.version,
    commit: c.env.APP_COMMIT || 'dev',
    protocol: { min: MIN_PROTOCOL, max: PROTOCOL_VERSION },
    features: [
      ...SERVER_FEATURES,
      ...CAPABILITIES.filter((cap) => capabilities[cap]).map((cap) => `capability:${cap}`),
    ],
  };
  c.header('Cache-Control', CACHE_CONTROL);
  // A plain GET without credentials: any origin may read it.
  c.header('Access-Control-Allow-Origin', '*');
  return c.json(info);
}
