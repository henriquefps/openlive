// SPDX-License-Identifier: AGPL-3.0-only
// Where an instance is served: a custom domain on a zone of the account, or a workers.dev
// address. Pure: the zone list and the account's workers.dev subdomain come from the caller.

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split('.');
  return (
    labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1) ?? '')
  );
}

/** Worker names: what Cloudflare accepts and what also works as a workers.dev label. */
export function validWorkerName(name: string): boolean {
  return LABEL.test(name);
}

export type Route =
  | { kind: 'custom_domain'; domain: string }
  /** `subdomain` is the account's workers.dev subdomain, unknown until it is looked up. */
  | { kind: 'workers_dev'; subdomain?: string };

/** Shown instead of the account's subdomain until the setup has looked it up. */
export const UNKNOWN_SUBDOMAIN = 'your-subdomain';

export function hostOf(route: Route, workerName: string): string {
  return route.kind === 'custom_domain'
    ? route.domain
    : `${workerName}.${route.subdomain ?? UNKNOWN_SUBDOMAIN}.workers.dev`;
}

export function originOf(route: Route, workerName: string): string {
  return `https://${hostOf(route, workerName)}`;
}

export function describeRoute(route: Route, workerName: string): string {
  return route.kind === 'custom_domain'
    ? `https://${route.domain} (custom domain)`
    : `https://${hostOf(route, workerName)} (workers.dev${route.subdomain ? '' : ', subdomain looked up in the real run'})`;
}

/** The zone names a host can belong to, longest first: a.b.example.com → b.example.com, example.com. */
export function zoneCandidates(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export interface Zone {
  id: string;
  name: string;
  /** initializing | pending | active | moved */
  status: string;
}

export type ZoneResolution =
  | { ok: true; zone: Zone }
  | { ok: false; reason: 'not_found' | 'not_active'; zone?: Zone; fix: string };

/** The zone that serves `host` (the longest matching zone name) and whether it can take a route. */
export function resolveZone(host: string, zones: readonly Zone[]): ZoneResolution {
  for (const name of zoneCandidates(host)) {
    const zone = zones.find((z) => z.name === name);
    if (!zone) continue;
    if (zone.status === 'active') return { ok: true, zone };
    return {
      ok: false,
      reason: 'not_active',
      zone,
      fix:
        `the zone ${zone.name} is ${zone.status}: finish adding it in the dashboard (point the ` +
        "registrar's nameservers to Cloudflare) and wait until it is active, or use --workers-dev",
    };
  }
  const apex = zoneCandidates(host).at(-1) ?? host;
  return {
    ok: false,
    reason: 'not_found',
    fix:
      `no zone for ${host} in this account: add ${apex} to the account (dashboard → Add a domain), ` +
      'pick another --account-id, or use --workers-dev <name>',
  };
}

/** The default Worker name for an environment with a custom domain. */
export function defaultWorkerName(env: string): string {
  return env === 'production' ? 'openlive' : `openlive-${env}`;
}

/** The default sender for a route; null when there is none (workers.dev can't be verified). */
export function defaultEmailFrom(route: Route): string | null {
  return route.kind === 'custom_domain' ? `Openlive <login@${route.domain}>` : null;
}
