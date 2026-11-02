// SPDX-License-Identifier: AGPL-3.0-only
// Checks that stop a deploy before anything is created. Messages name keys, never values.

import type { EnvFacts } from './config.ts';
import { FORBIDDEN_IN_DEPLOY } from './secrets.ts';

/**
 * DEV_AUTH turns on the development identity (apps/api/src/room/identity.ts): any caller could
 * name any user. It must never reach a deployed environment, whatever its value.
 */
export function devAuthProblems(
  facts: EnvFacts,
  secretNames: Iterable<string>,
  remoteSecretNames: Iterable<string> = [],
): string[] {
  const problems: string[] = [];
  const secrets = new Set(secretNames);
  const remote = new Set(remoteSecretNames);
  for (const name of FORBIDDEN_IN_DEPLOY) {
    if (name in facts.vars) problems.push(`env.${facts.env}.vars in wrangler.jsonc sets ${name}`);
    if (secrets.has(name)) problems.push(`the secrets file sets ${name}`);
    if (remote.has(name)) {
      problems.push(
        `the deployed Worker ${facts.workerName} has a ${name} secret ` +
          `(remove it: wrangler secret delete ${name} --env ${facts.env})`,
      );
    }
  }
  return problems;
}

/** APP_ORIGIN must be the origin the instance is served from, or login redirects break. */
export function appOriginProblems(facts: EnvFacts): string[] {
  const origin = facts.vars['APP_ORIGIN'];
  if (origin === undefined) return [`env.${facts.env}.vars has no APP_ORIGIN`];
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return [`APP_ORIGIN is not a URL`];
  }
  if (url.origin !== origin) return [`APP_ORIGIN must be an origin with no path (${url.origin})`];
  if (url.protocol !== 'https:') return [`APP_ORIGIN must use https in env.${facts.env}`];
  if (facts.customDomains.length > 0 && !facts.customDomains.includes(url.host)) {
    return [
      `APP_ORIGIN host ${url.host} is not one of the custom domains (${facts.customDomains.join(', ')})`,
    ];
  }
  if (facts.customDomains.length === 0 && !url.host.endsWith('.workers.dev')) {
    return [`APP_ORIGIN host ${url.host} has no custom_domain route and is not a workers.dev host`];
  }
  return [];
}

/** At least one way to sign in is needed, or nobody can claim the instance with the install code. */
export function loginProblems(secrets: Map<string, string>): string[] {
  const has = (k: string) => (secrets.get(k) ?? '') !== '';
  const discordId = has('DISCORD_CLIENT_ID');
  const discordSecret = has('DISCORD_CLIENT_SECRET');
  if (discordId !== discordSecret) {
    return ['set both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or neither'];
  }
  if (!discordId && !has('RESEND_API_KEY')) {
    return [
      'no login method: fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or RESEND_API_KEY',
    ];
  }
  return [];
}

/** A Realtime id without its token (or the reverse) can't be repaired: the token is shown once. */
export function realtimePairProblems(secrets: Map<string, string>): string[] {
  const has = (k: string) => (secrets.get(k) ?? '') !== '';
  const problems: string[] = [];
  for (const [id, token] of [
    ['REALTIME_APP_ID', 'REALTIME_APP_TOKEN'],
    ['TURN_KEY_ID', 'TURN_KEY_TOKEN'],
  ] as const) {
    if (has(id) !== has(token)) {
      problems.push(`${id} and ${token} must be set together (clear both to create a new one)`);
    }
  }
  return problems;
}
