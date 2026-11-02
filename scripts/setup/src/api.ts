// SPDX-License-Identifier: AGPL-3.0-only
// Read-only HTTP calls of the setup: the Cloudflare API (zones, the workers.dev subdomain, R2,
// the Worker's domains, token checks) and the checks of the keys a person pastes (Resend,
// Discord). `fetch` is a parameter so the tests use a fake. Nothing here creates anything, sends
// an e-mail, or puts a key or token in a message.

import type { Zone } from './domain.ts';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const CF = 'https://api.cloudflare.com/client/v4';

export class ApiError extends Error {}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

export interface CfResponse<T> {
  status: number;
  success: boolean;
  result: T | undefined;
  errors: { code: number; message: string }[];
}

export interface CfClient {
  fetch: FetchFn;
  token: string;
  /** Waits between retries; the tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One Cloudflare API call. A 5xx is retried twice: the API sometimes answers a transient 500
 * (seen during the first deploy), and every call here is a read, so a retry is safe.
 */
export async function cfCall<T>(
  c: CfClient,
  path: string,
  init: RequestInit = {},
): Promise<CfResponse<T>> {
  const sleep = c.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await c.fetch(`${CF}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${c.token}`,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ApiError(`Cloudflare API ${path.split('?')[0]}: ${(err as Error).message}`);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    let body: CfEnvelope<T> = {};
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      // A non-JSON answer (an HTML error page): only the status is useful.
    }
    return {
      status: res.status,
      success: res.ok && body.success !== false,
      result: body.result,
      errors: (body.errors ?? []).map((e) => ({ code: e.code ?? 0, message: e.message ?? '' })),
    };
  }
}

const describe = (r: CfResponse<unknown>) =>
  r.errors.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;

/** The account's zones whose name is one of `names`. */
export async function findZones(
  c: CfClient,
  accountId: string,
  names: readonly string[],
): Promise<Zone[]> {
  const zones: Zone[] = [];
  for (const name of names) {
    const q = new URLSearchParams({ name, 'account.id': accountId });
    const r = await cfCall<Zone[]>(c, `/zones?${q}`);
    if (!r.success) throw new ApiError(`listing zones failed: ${describe(r)}`);
    for (const z of r.result ?? []) zones.push({ id: z.id, name: z.name, status: z.status });
  }
  return zones;
}

/** The account's workers.dev subdomain, or null when none was ever chosen. */
export async function workersSubdomain(c: CfClient, accountId: string): Promise<string | null> {
  const r = await cfCall<{ subdomain?: string }>(c, `/accounts/${accountId}/workers/subdomain`);
  if (r.success) return r.result?.subdomain || null;
  if (r.status === 404 || r.errors.some((e) => e.code === 10007)) return null;
  throw new ApiError(`reading the workers.dev subdomain failed: ${describe(r)}`);
}

export type R2State = 'enabled' | 'not_enabled';

/** Whether R2 is enabled on the account (it asks for a payment method the first time). */
export async function r2State(c: CfClient, accountId: string): Promise<R2State> {
  const r = await cfCall<unknown>(c, `/accounts/${accountId}/r2/buckets?per_page=1`);
  if (r.success) return 'enabled';
  if (r.errors.some((e) => e.code === 10042 || /enable r2/i.test(e.message))) return 'not_enabled';
  throw new ApiError(`listing R2 buckets failed: ${describe(r)}`);
}

/** The custom domains a deployed Worker already has (to default the address on a rerun). */
export async function workerDomains(
  c: CfClient,
  accountId: string,
  service: string,
): Promise<string[]> {
  const q = new URLSearchParams({ service });
  const r = await cfCall<{ hostname?: string; service?: string }[]>(
    c,
    `/accounts/${accountId}/workers/domains?${q}`,
  );
  if (!r.success) return [];
  return (r.result ?? [])
    .filter((d) => d.service === service && d.hostname)
    .map((d) => d.hostname as string);
}

export type ValidationStatus = 'valid' | 'invalid' | 'unknown';

export interface Validation {
  status: ValidationStatus;
  detail: string;
  warnings: string[];
}

const result = (status: ValidationStatus, detail: string, warnings: string[] = []): Validation => ({
  status,
  detail,
  warnings,
});

/**
 * The analytics token (CLOUDFLARE_API_TOKEN): active, and able to read the Realtime dataset the
 * usage cron reads. One row of TURN usage over the last day; nothing is written.
 */
export async function verifyAnalyticsToken(
  fetchFn: FetchFn,
  token: string,
  accountId: string,
  now: Date = new Date(),
  sleep?: (ms: number) => Promise<void>,
): Promise<Validation> {
  const c: CfClient = sleep ? { fetch: fetchFn, token, sleep } : { fetch: fetchFn, token };
  try {
    // User tokens verify on /user, account-owned tokens on the account.
    let v = await cfCall<{ status?: string }>(c, '/user/tokens/verify');
    if (!v.success)
      v = await cfCall<{ status?: string }>(c, `/accounts/${accountId}/tokens/verify`);
    if (!v.success)
      return result('invalid', `Cloudflare does not accept the token (${describe(v)})`);
    if (v.result?.status !== 'active') {
      return result('invalid', `the token is ${v.result?.status ?? 'not active'}`);
    }
    const query = `query ($a: string!, $s: Time!, $e: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { egressBytes } }
  } }
}`;
    const variables = {
      a: accountId,
      s: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      e: now.toISOString(),
    };
    const res = await c.fetch(`${CF}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status >= 500) return result('unknown', `the GraphQL API answered ${res.status}`);
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: unknown[] } } | null;
      errors?: { message?: string }[] | null;
    };
    if (body.errors?.length) {
      return result(
        'invalid',
        'the token cannot read Account Analytics for this account ' +
          `(${body.errors.map((e) => e.message ?? '').join('; ')}); it needs Account → Account Analytics → Read`,
      );
    }
    if (!body.data?.viewer?.accounts?.length) {
      return result('invalid', 'the token does not see this account in Account Analytics');
    }
    return result('valid', 'active, and reads the Realtime usage of this account');
  } catch (err) {
    return result('unknown', `could not reach Cloudflare (${(err as Error).message})`);
  }
}

/**
 * The Resend key. GET /domains sends nothing: a full-access key lists the domains (so the
 * sender's domain is checked too); a send-only key, the kind the guide asks for, is refused with
 * `restricted_api_key`, which still proves the key is real; any other refusal means a bad key.
 */
export async function verifyResendKey(
  fetchFn: FetchFn,
  key: string,
  senderDomain: string | null,
): Promise<Validation> {
  let res: Response;
  try {
    res = await fetchFn('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    return result('unknown', `could not reach Resend (${(err as Error).message})`);
  }
  let body: { name?: string; message?: string; data?: { name?: string; status?: string }[] } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Only the status is useful.
  }
  if (res.ok) {
    const warnings: string[] = ['the key has full access; a send-only key is enough'];
    if (senderDomain) {
      const domains = body.data ?? [];
      const match = domains.find(
        (d) => d.name === senderDomain || (d.name && senderDomain.endsWith(`.${d.name}`)),
      );
      if (!match) {
        warnings.push(
          `${senderDomain} is not a domain in this Resend account: add and verify it ` +
            '(Resend → Domains), or e-mail reaches only your own address',
        );
      } else if (match.status !== 'verified') {
        warnings.push(
          `the Resend domain ${match.name} is ${match.status ?? 'not verified'}: add its DNS ` +
            'records and wait until it is verified',
        );
      }
    }
    return result('valid', 'accepted by Resend', warnings);
  }
  if (body.name === 'restricted_api_key') {
    return result(
      'valid',
      'accepted by Resend (send-only, so the domain verification could not be checked)',
    );
  }
  if (res.status === 401 || res.status === 403 || body.name === 'invalid_api_key') {
    return result('invalid', `Resend refused the key (${body.name ?? res.status})`);
  }
  if (res.status === 429) return result('unknown', 'Resend is rate limiting; not checked');
  return result('unknown', `Resend answered ${res.status}; not checked`);
}

/**
 * The Discord application: a client-credentials token for the app itself proves the id and
 * the secret belong together. The token is dropped; nobody signs in.
 */
export async function verifyDiscordApp(
  fetchFn: FetchFn,
  clientId: string,
  clientSecret: string,
): Promise<Validation> {
  let res: Response;
  try {
    res = await fetchFn('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }).toString(),
    });
  } catch (err) {
    return result('unknown', `could not reach Discord (${(err as Error).message})`);
  }
  if (res.ok) return result('valid', 'the client id and secret match');
  let error: string | undefined;
  try {
    error = ((await res.json()) as { error?: string }).error;
  } catch {
    // Only the status is useful.
  }
  if (res.status === 401 || error === 'invalid_client') {
    return result(
      'invalid',
      'Discord refused the client id and secret (copy them again from OAuth2 → General)',
    );
  }
  return result('unknown', `Discord answered ${res.status}; not checked`);
}
