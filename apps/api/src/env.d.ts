// SPDX-License-Identifier: AGPL-3.0-only
// Secrets that `wrangler types` does not see because they are never in wrangler.jsonc (APP_ORIGIN
// and EMAIL_FROM are wrangler.jsonc vars, typed in worker-configuration.d.ts).
// Every one is optional: a missing secret turns its feature off (fail closed), never on.

interface AuthEnv {
  /** "1" enables the development identity (room/identity.ts), on localhost only. Never deploy it. */
  DEV_AUTH?: string | undefined;
  /** HMAC key for the signed login cookies, IP hashes and rate-limit buckets. */
  SESSION_SECRET?: string | undefined;
  DISCORD_CLIENT_ID?: string | undefined;
  DISCORD_CLIENT_SECRET?: string | undefined;
  /** Resend API key (sending access) for the magic link. */
  RESEND_API_KEY?: string | undefined;
  /** Install code that lets the first user claim the platform admin role. */
  INSTALL_CODE?: string | undefined;
  /** Realtime SFU app and its token; the onboarding checks test them (api/checks.ts). */
  REALTIME_APP_ID?: string | undefined;
  REALTIME_APP_TOKEN?: string | undefined;
  /** Realtime TURN key and its token. */
  TURN_KEY_ID?: string | undefined;
  TURN_KEY_TOKEN?: string | undefined;
  /**
   * API token with Account > Account Analytics > Read, and the account id: the usage cron
   * (usage/scheduled.ts) and the status page's Analytics Engine queries (metrics/status.ts).
   */
  CLOUDFLARE_API_TOKEN?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  /** "1" logs every Analytics Engine data point as it is written (metrics/points.ts). */
  METRICS_LOG?: string | undefined;
  /**
   * Workers Logs head_sampling_rate, 0 to 1 (a var the setup renders from the config):
   * the limits panel's log events estimate. Missing means every invocation is logged.
   */
  LOG_SAMPLING_RATE?: string | undefined;
}

// Declaration merging adds AuthEnv to both the global Env and Cloudflare.Env.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Env extends AuthEnv {}

declare namespace Cloudflare {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Env extends AuthEnv {}
}
