// SPDX-License-Identifier: AGPL-3.0-only
// One deployed instance's settings: apps/api/.instance.<env>.json (git-ignored). The committed
// wrangler.jsonc only has a generic template environment; what makes an instance yours (Worker
// name, address, sender, resource names and ids) lives here, and the setup renders both into
// wrangler.<env>.generated.jsonc.
//
// Instances set up before this file existed have only the generated config: their settings are
// recovered from it, so a rerun finds the existing resources and recreates nothing.

import { PLACEHOLDER_ID, readEnvFacts } from './config.ts';
import {
  defaultEmailFrom,
  defaultWorkerName,
  type Route,
  validHostname,
  validWorkerName,
} from './domain.ts';

export interface Instance {
  version: 1;
  workerName: string;
  route: Route;
  /** The magic-link sender; null uses the Worker's default (Resend's test sender). */
  emailFrom: string | null;
  /** The account the resources were created in, once known. */
  accountId: string | null;
  d1: { databaseName: string; databaseId: string | null };
  /** `created`: this setup created it (or saw it exist), so a dry run can show it as kept. */
  r2: { bucketName: string; created: boolean };
  /** Workers Logs head sampling rate (`--log-sampling`); absent uses the template's. */
  logSampling?: number;
}

export class InstanceError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseInstance(text: string, file: string): Instance {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InstanceError(`${file} is not valid JSON`);
  }
  const bad = (what: string) => new InstanceError(`${file}: ${what}`);
  if (!isObj(raw) || raw['version'] !== 1) throw bad('unknown version (expected 1)');
  const workerName = raw['workerName'];
  if (typeof workerName !== 'string' || !validWorkerName(workerName)) throw bad('bad workerName');
  const r = raw['route'];
  let route: Route;
  if (isObj(r) && r['kind'] === 'custom_domain' && typeof r['domain'] === 'string') {
    if (!validHostname(r['domain'])) throw bad('bad route.domain');
    route = { kind: 'custom_domain', domain: r['domain'] };
  } else if (isObj(r) && r['kind'] === 'workers_dev') {
    const sub = strOrNull(r['subdomain']);
    route = sub ? { kind: 'workers_dev', subdomain: sub } : { kind: 'workers_dev' };
  } else throw bad('route must be {kind: "custom_domain", domain} or {kind: "workers_dev"}');
  const d1 = raw['d1'];
  const r2 = raw['r2'];
  if (!isObj(d1) || typeof d1['databaseName'] !== 'string') throw bad('bad d1');
  if (!isObj(r2) || typeof r2['bucketName'] !== 'string') throw bad('bad r2');
  const sampling = raw['logSampling'];
  if (sampling !== undefined && !validSampling(sampling)) throw bad('bad logSampling (0 to 1)');
  return {
    version: 1,
    workerName,
    route,
    emailFrom: strOrNull(raw['emailFrom']),
    accountId: strOrNull(raw['accountId']),
    d1: { databaseName: d1['databaseName'], databaseId: strOrNull(d1['databaseId']) },
    r2: { bucketName: r2['bucketName'], created: r2['created'] === true },
    ...(typeof sampling === 'number' ? { logSampling: sampling } : {}),
  };
}

export const validSampling = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export const INSTANCE_NOTE =
  'Settings of this Openlive instance, written by `pnpm run setup` (git-ignored). Holds no secrets.';

export function serializeInstance(inst: Instance): string {
  return JSON.stringify({ $comment: INSTANCE_NOTE, ...inst }, null, 2) + '\n';
}

/**
 * Recovers an instance from a generated config written by an earlier setup (before
 * .instance.<env>.json existed). `laterStepsDone`: the secrets file holds values the old setup
 * only wrote after creating the R2 bucket, so the bucket exists.
 */
export function recoverFromGenerated(
  text: string,
  env: string,
  laterStepsDone: boolean,
): Instance | null {
  let facts;
  try {
    facts = readEnvFacts(text, env);
  } catch {
    return null;
  }
  const domain = facts.customDomains[0];
  let route: Route | null = null;
  if (domain) route = { kind: 'custom_domain', domain };
  else if (facts.workersDev) {
    const host = facts.vars['APP_ORIGIN'] ? safeHost(facts.vars['APP_ORIGIN']) : null;
    const m = host ? /^[^.]+\.([^.]+)\.workers\.dev$/.exec(host) : null;
    route = m?.[1] ? { kind: 'workers_dev', subdomain: m[1] } : { kind: 'workers_dev' };
  }
  if (!route || !validWorkerName(facts.workerName)) return null;
  const dbId = facts.d1?.databaseId ?? '';
  return {
    version: 1,
    workerName: facts.workerName,
    route,
    emailFrom: strOrNull(facts.vars['EMAIL_FROM']),
    accountId: strOrNull(facts.accountId),
    d1: {
      databaseName: facts.d1?.databaseName ?? facts.workerName,
      databaseId: dbId && dbId !== PLACEHOLDER_ID ? dbId : null,
    },
    r2: {
      bucketName: facts.r2?.bucketName ?? `${facts.workerName}-thumbnails`,
      created: laterStepsDone,
    },
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export interface TargetRequest {
  env: string;
  domain?: string | undefined;
  workersDev?: string | undefined;
  name?: string | undefined;
  emailFrom?: string | undefined;
  logSampling?: number | undefined;
}

export type InstanceSource = 'file' | 'recovered' | 'new';

export interface Target {
  source: InstanceSource;
  /** The instance to deploy; its route is provisional while `question` is set. */
  instance: Instance;
  /**
   * choose: no address known, the setup asks for one (or needs --domain / --workers-dev).
   * confirm: an address was recovered from an older setup and is confirmed once.
   */
  question: null | 'choose' | 'confirm';
  /** Whether .instance.<env>.json must be (re)written. */
  write: boolean;
  notes: string[];
  errors: string[];
}

function sameRoute(a: Route, b: Route): boolean {
  return a.kind === b.kind && (a.kind !== 'custom_domain' || a.domain === (b as typeof a).domain);
}

/**
 * Settles the instance from the flags, the instance file, or a recovered generated config, in
 * that order. Never changes the Worker name of an existing instance: that would be a new one.
 */
export function resolveTarget(
  req: TargetRequest,
  fromFile: Instance | null,
  recovered: Instance | null,
  detectedDomain: string | null = null,
): Target {
  const base = fromFile ?? recovered;
  const source: InstanceSource = fromFile ? 'file' : recovered ? 'recovered' : 'new';
  const notes: string[] = [];
  const errors: string[] = [];

  const workerName = req.workersDev ?? req.name ?? base?.workerName ?? defaultWorkerName(req.env);
  if (base && workerName !== base.workerName) {
    errors.push(
      `env ${req.env} is the instance of Worker ${base.workerName}; the setup never renames it. ` +
        `For a second instance named ${workerName}, add --env ${workerName}`,
    );
  }

  let requested: Route | null = null;
  if (req.domain) requested = { kind: 'custom_domain', domain: req.domain };
  else if (req.workersDev) {
    requested =
      base?.route.kind === 'workers_dev' && base.route.subdomain
        ? { kind: 'workers_dev', subdomain: base.route.subdomain }
        : { kind: 'workers_dev' };
  }

  let question: Target['question'] = null;
  let route: Route;
  if (requested) route = requested;
  else if (base) {
    route = base.route;
    if (source === 'recovered') question = 'confirm';
  } else if (detectedDomain) {
    route = { kind: 'custom_domain', domain: detectedDomain };
    question = 'confirm';
  } else {
    route = { kind: 'workers_dev' };
    question = 'choose';
  }
  if (base && requested && !sameRoute(base.route, requested)) {
    notes.push(
      'the address changes: update the Discord redirect and tell your users; ' +
        'the old address stops working after the deploy',
    );
  }

  // Keep a sender the person chose; follow the address when it was only the default.
  let emailFrom = req.emailFrom ?? null;
  if (!emailFrom && base?.emailFrom) {
    emailFrom =
      base.emailFrom === defaultEmailFrom(base.route) ? defaultEmailFrom(route) : base.emailFrom;
  }
  if (!emailFrom) emailFrom = defaultEmailFrom(route);

  const instance: Instance = {
    version: 1,
    workerName,
    route,
    emailFrom,
    accountId: base?.accountId ?? null,
    d1: base?.d1 ?? { databaseName: workerName, databaseId: null },
    r2: base?.r2 ?? { bucketName: `${workerName}-thumbnails`, created: false },
  };
  const logSampling = req.logSampling ?? base?.logSampling;
  if (logSampling !== undefined) instance.logSampling = logSampling;
  const write =
    source !== 'file' ||
    (fromFile !== null && serializeInstance(fromFile) !== serializeInstance(instance));
  return { source, instance, question, write, notes, errors };
}

/** The target with facts learned during the run (account, subdomain, ids) merged in. */
export function patchTarget(
  target: Target,
  fromFile: Instance | null,
  patch: Partial<Omit<Instance, 'version'>>,
): Target {
  const instance: Instance = { ...target.instance, ...patch };
  const write =
    target.source !== 'file' ||
    (fromFile !== null && serializeInstance(fromFile) !== serializeInstance(instance));
  return { ...target, instance, write };
}
