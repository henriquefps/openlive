// SPDX-License-Identifier: AGPL-3.0-only
// The onboarding wizard's checks: is each secret configured, and do the
// services behind them answer. Every check is read-only: nothing is created, sent or stored.
// Results are codes plus the names of missing secrets, never a secret value or a response body.

export const REALTIME_API = 'https://rtc.live.cloudflare.com/v1';

/** How long one outside call may take before it counts as unreachable. */
const TIMEOUT_MS = 5_000;

export type CheckId = 'discord' | 'email' | 'sfu' | 'turn' | 'd1' | 'r2';
export type CheckStatus = 'ok' | 'missing' | 'error';
/**
 * `configured`: present and (where tested) accepted. `secret_missing`: see `missing`.
 * `auth_failed`: the service refused the credentials. `unreachable`: no answer, a timeout or a
 * 5xx. `unexpected_response`: any other answer. `binding_failed`: D1 or R2 threw.
 */
export type CheckCode =
  | 'configured'
  | 'secret_missing'
  | 'auth_failed'
  | 'unreachable'
  | 'unexpected_response'
  | 'binding_failed';

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  code: CheckCode;
  /** Names (not values) of the secrets or vars that are not set. */
  missing?: string[];
}

/** The secrets and bindings the checks read; all optional so a bare instance still answers. */
export interface ChecksEnv {
  DB: D1Database;
  THUMBNAILS: R2Bucket;
  DISCORD_CLIENT_ID?: string | undefined;
  DISCORD_CLIENT_SECRET?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
  REALTIME_APP_ID?: string | undefined;
  REALTIME_APP_TOKEN?: string | undefined;
  TURN_KEY_ID?: string | undefined;
  TURN_KEY_TOKEN?: string | undefined;
}

type SecretName = Exclude<keyof ChecksEnv, 'DB' | 'THUMBNAILS'>;

function missingOf(env: ChecksEnv, names: SecretName[]): string[] {
  return names.filter((n) => !env[n]?.trim());
}

const ok = (id: CheckId): CheckResult => ({ id, status: 'ok', code: 'configured' });
const error = (id: CheckId, code: CheckCode): CheckResult => ({ id, status: 'error', code });

/** Checks that the secrets exist, then (when `probe` is given) that the service accepts them. */
async function secrets(
  env: ChecksEnv,
  id: CheckId,
  names: SecretName[],
  probe?: () => Promise<CheckResult>,
): Promise<CheckResult> {
  const missing = missingOf(env, names);
  if (missing.length > 0) return { id, status: 'missing', code: 'secret_missing', missing };
  return probe ? probe() : ok(id);
}

/** Maps a probe's HTTP answer: 2xx is ok, 401/403 is refused credentials, 5xx is down. */
async function httpProbe(
  id: CheckId,
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  accept: (status: number) => boolean = (s) => s >= 200 && s < 300,
  codes: Partial<Record<number, CheckCode>> = {},
): Promise<CheckResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return error(id, 'unreachable');
  }
  // The body may carry credentials (TURN); it is discarded unread.
  await res.body?.cancel();
  if (accept(res.status)) return ok(id);
  const mapped = codes[res.status];
  if (mapped) return error(id, mapped);
  if (res.status === 401 || res.status === 403) return error(id, 'auth_failed');
  if (res.status >= 500) return error(id, 'unreachable');
  return error(id, 'unexpected_response');
}

export async function runChecks(
  env: ChecksEnv,
  fetchFn: typeof fetch = fetch,
): Promise<CheckResult[]> {
  return Promise.all([
    // Discord is only called during a login, so presence is all that can be checked here.
    secrets(env, 'discord', ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']),
    // Resend has no free read-only call with a sending-access key; presence only.
    secrets(env, 'email', ['RESEND_API_KEY', 'EMAIL_FROM']),
    // Realtime SFU: a renegotiate with an empty body on a session id that cannot exist. Realtime
    // authenticates and validates the body before it looks the session up, so nothing is created
    // or touched. Checked on 2026-10-27, all in ~0.25 s: a valid token answers 400 decoding_error,
    // a wrong token 401, a wrong app id 404. (A GET on a made-up session also authenticates, but
    // takes ~14 s to answer 425, past the timeout.)
    secrets(env, 'sfu', ['REALTIME_APP_ID', 'REALTIME_APP_TOKEN'], () =>
      httpProbe(
        'sfu',
        fetchFn,
        `${REALTIME_API}/apps/${encodeURIComponent(env.REALTIME_APP_ID ?? '')}/sessions/${crypto.randomUUID().replaceAll('-', '')}/renegotiate`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${env.REALTIME_APP_TOKEN ?? ''}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
        (s) => s === 400,
        { 404: 'auth_failed' },
      ),
    ),
    // TURN: generates one credential that expires in 60 s and is thrown away.
    secrets(env, 'turn', ['TURN_KEY_ID', 'TURN_KEY_TOKEN'], () =>
      httpProbe(
        'turn',
        fetchFn,
        `${REALTIME_API}/turn/keys/${encodeURIComponent(env.TURN_KEY_ID ?? '')}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.TURN_KEY_TOKEN ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ttl: 60 }),
        },
      ),
    ),
    (async () => {
      try {
        await env.DB.prepare('SELECT 1').first();
        return ok('d1');
      } catch {
        return error('d1', 'binding_failed');
      }
    })(),
    (async () => {
      // A head on a key that is never written: null (absent) proves the bucket answers.
      try {
        await env.THUMBNAILS.head('openlive-check');
        return ok('r2');
      } catch {
        return error('r2', 'binding_failed');
      }
    })(),
  ]);
}
