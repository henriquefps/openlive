// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs } from 'node:util';
import { validHostname, validWorkerName } from './domain.ts';

export interface Args {
  env: string;
  yes: boolean;
  dryRun: boolean;
  check: boolean;
  accountId: string | undefined;
  /** A custom domain on a zone of the account (`--domain live.example.com`). */
  domain: string | undefined;
  /** A workers.dev address: the Worker name (`--workers-dev openlive`). */
  workersDev: string | undefined;
  /** The Worker name with a custom domain (it is the workers.dev name otherwise). */
  name: string | undefined;
  /** The magic-link sender, e.g. `Openlive <login@live.example.com>`. */
  emailFrom: string | undefined;
  /** Deploy without the Analytics Engine binding (metrics off). */
  noMetrics: boolean;
  /** Workers Logs head sampling rate, 0 to 1 (`--log-sampling 0.1`); kept by the instance. */
  logSampling: number | undefined;
  help: boolean;
}

export const USAGE = `Usage: pnpm run setup -- [--env <name>] [--domain <host> | --workers-dev <name>]
                       [--name <worker>] [--email-from <sender>] [--no-metrics]
                       [--log-sampling <0..1>]
                       [--dry-run | --check] [--yes] [--account-id <id>]

Creates what a deployed Openlive instance needs in your Cloudflare account (D1, R2, Realtime SFU
app and TURN key), stores the secrets in apps/api/.secrets.<env>, applies the D1 migrations and
deploys. Safe to run again: it keeps what exists and continues where a failed run stopped.
See docs/self-host.md.

  --env <name>           the instance's local name (default: production). Its settings live in
                         apps/api/.instance.<env>.json and its secrets in apps/api/.secrets.<env>
  --domain <host>        serve the instance on a custom domain of a zone in your account
  --workers-dev <name>   serve it on <name>.<your-subdomain>.workers.dev (no domain needed)
  --name <worker>        the Worker name with --domain (default: openlive, or openlive-<env>)
  --email-from <sender>  the magic-link sender on a domain verified in Resend
                         (default with --domain: Openlive <login@<domain>>)
  --no-metrics           deploy without the Analytics Engine binding (metrics off); the setup
                         also falls back to this when the account has not enabled Analytics Engine
  --log-sampling <rate>  the share of invocations Workers Logs keeps, 0 to 1 (default 0.1: the
                         Workers Free plan has 200,000 log events a day; see docs/self-host.md).
                         Kept for the instance until passed again
  --dry-run              print the checks and the plan, then stop; calls nothing, writes nothing
  --check                run the checks (read-only Cloudflare calls), then stop
  --yes                  do not ask before each step
  --account-id <id>      the account to use when you have more than one

Without --domain or --workers-dev, the setup uses the address it already knows for the
instance, or asks for one.`;

export class ArgsError extends Error {}

const ENV_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function parseCliArgs(argv: string[]): Args {
  // `pnpm run setup -- --env x` may pass the separator through.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        env: { type: 'string', default: 'production' },
        yes: { type: 'boolean', short: 'y', default: false },
        'dry-run': { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        'account-id': { type: 'string' },
        domain: { type: 'string' },
        'workers-dev': { type: 'string' },
        name: { type: 'string' },
        'email-from': { type: 'string' },
        'no-metrics': { type: 'boolean', default: false },
        'log-sampling': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw new ArgsError((err as Error).message);
  }
  const parsed: Args = {
    env: values.env,
    yes: values.yes,
    dryRun: values['dry-run'],
    check: values.check,
    accountId: values['account-id'],
    domain: values.domain?.trim().toLowerCase().replace(/\.$/, ''),
    workersDev: values['workers-dev']?.trim().toLowerCase(),
    name: values.name?.trim().toLowerCase(),
    emailFrom: values['email-from']?.trim(),
    noMetrics: values['no-metrics'],
    logSampling: undefined,
    help: values.help,
  };
  if (parsed.help) return parsed;

  if (!ENV_NAME.test(parsed.env)) {
    throw new ArgsError('--env must be lowercase letters, digits and dashes (up to 32)');
  }
  if (parsed.dryRun && parsed.check) throw new ArgsError('use --dry-run or --check, not both');
  if (parsed.domain !== undefined && parsed.workersDev !== undefined) {
    throw new ArgsError('use --domain or --workers-dev, not both');
  }
  if (parsed.domain !== undefined) {
    if (/^https?:\/\//.test(parsed.domain) || parsed.domain.includes('/')) {
      throw new ArgsError('--domain takes a host name only, e.g. --domain live.example.com');
    }
    if (parsed.domain.endsWith('.workers.dev')) {
      throw new ArgsError('for a workers.dev address use --workers-dev <name>');
    }
    if (!validHostname(parsed.domain))
      throw new ArgsError(`--domain ${parsed.domain} is not a host name`);
  }
  if (parsed.workersDev !== undefined) {
    if (parsed.name !== undefined && parsed.name !== parsed.workersDev) {
      throw new ArgsError('with --workers-dev the name is the Worker name; drop --name');
    }
    if (!validWorkerName(parsed.workersDev)) {
      throw new ArgsError(
        '--workers-dev takes a Worker name: lowercase letters, digits and dashes (up to 63), ' +
          'not starting or ending with a dash',
      );
    }
  }
  if (parsed.name !== undefined && !validWorkerName(parsed.name)) {
    throw new ArgsError('--name must be lowercase letters, digits and dashes (up to 63)');
  }
  const sampling = values['log-sampling']?.trim();
  if (sampling !== undefined) {
    const rate = /^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(sampling) ? Number(sampling) : NaN;
    if (!(rate >= 0 && rate <= 1)) {
      throw new ArgsError('--log-sampling takes a number from 0 to 1, e.g. --log-sampling 0.1');
    }
    parsed.logSampling = rate;
  }
  if (parsed.emailFrom !== undefined && !emailAddressOf(parsed.emailFrom)) {
    throw new ArgsError('--email-from must hold an address, e.g. "Openlive <login@example.com>"');
  }
  return parsed;
}

/** The bare address of a sender like `Name <a@b.c>` or `a@b.c`, or null. */
export function emailAddressOf(sender: string): string | null {
  const m = /^(?:[^<>]*<\s*([^<>\s]+)\s*>|([^<>\s]+))$/.exec(sender.trim());
  const addr = m?.[1] ?? m?.[2];
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at <= 0 || !validHostname(addr.slice(at + 1).toLowerCase())) return null;
  return addr;
}
