// SPDX-License-Identifier: AGPL-3.0-only
// What the setup will do for one environment, computed from the config, the instance settings,
// the secrets file and (outside --dry-run) what already exists in the account. Pure: no I/O, no
// secret values. A failed run leaves its progress in the instance and secrets files, so the plan
// of the rerun continues from there (see the "partial state" tests).

import type { EnvFacts } from './config.ts';
import { describeRoute } from './domain.ts';
import type { Target } from './instance.ts';
import {
  appOriginProblems,
  devAuthProblems,
  loginProblems,
  realtimePairProblems,
} from './guard.ts';
import { filledSecrets } from './secrets-file.ts';
import { SECRETS } from './secrets.ts';

/** What exists in the account. null in --dry-run, which never calls Cloudflare. */
export interface RemoteState {
  accountId: string;
  /** null when the database doesn't exist. */
  d1DatabaseId: string | null;
  bucketExists: boolean;
  workerExists: boolean;
  /** Secret names on the deployed Worker (names only). */
  remoteSecretNames: string[];
  /** Names of existing Realtime SFU apps / TURN keys; null when not listed. */
  sfuAppNames: string[] | null;
  turnKeyNames: string[] | null;
}

export interface PlanInput {
  /** The environment as it will be deployed (rendered from the template and the instance). */
  facts: EnvFacts;
  target: Target;
  /** All entries of the secrets file (empty values are placeholders). */
  secrets: Map<string, string>;
  secretsFileExists: boolean;
  remote: RemoteState | null;
  paths: { secretsFile: string; generatedConfig: string; instanceFile: string };
  /** The secrets assistant can ask for the login keys (a terminal, not --yes). */
  canAsk?: boolean;
  /** --no-metrics: deployed without the Analytics Engine binding. */
  metricsOff?: boolean;
}

export type StepId =
  | 'account'
  | 'address'
  | 'instance'
  | 'secrets-file'
  | 'login'
  | 'd1'
  | 'config'
  | 'r2'
  | 'sfu'
  | 'turn'
  | 'session-secret'
  | 'install-code'
  | 'account-id'
  | 'verify'
  | 'build'
  | 'migrations'
  | 'deploy';

/** create: a cloud resource. ensure: create if missing (state not queried). ask: a question. */
export type StepAction = 'create' | 'ensure' | 'skip' | 'write' | 'run' | 'ask';

export interface Step {
  id: StepId;
  action: StepAction;
  title: string;
  detail?: string;
}

export interface Plan {
  steps: Step[];
  /** Wrong configuration: the setup refuses to run. */
  errors: string[];
  /** Values the person must fill in before the real run can go on. */
  todo: string[];
  warnings: string[];
  /** Secret names the deploy uploads (values are never in the plan). */
  uploadNames: string[];
}

const has = (m: Map<string, string>, k: string) => (m.get(k) ?? '') !== '';

function step(id: StepId, action: StepAction, title: string, detail?: string): Step {
  return detail === undefined ? { id, action, title } : { id, action, title, detail };
}

export function computePlan(input: PlanInput): Plan {
  const { facts, secrets, remote, paths, target } = input;
  const inst = target.instance;
  const filled = filledSecrets(secrets);
  const steps: Step[] = [];
  const errors = [
    ...target.errors,
    ...devAuthProblems(facts, filled.keys(), remote?.remoteSecretNames ?? []),
    ...(target.question === 'choose' ? [] : appOriginProblems(facts)),
    ...realtimePairProblems(secrets),
  ];
  const login = loginProblems(secrets);
  const todo: string[] = [];
  const warnings: string[] = [...target.notes];

  steps.push(
    remote
      ? step('account', 'skip', `Cloudflare account ${remote.accountId}`, 'logged in with wrangler')
      : step(
          'account',
          'run',
          'Check the login: wrangler whoami (and cf auth whoami for Realtime)',
        ),
  );
  if (remote && inst.accountId && inst.accountId !== remote.accountId) {
    errors.push(
      `${paths.instanceFile} belongs to account ${inst.accountId}, but wrangler is logged in to ` +
        `${remote.accountId} (log in to that account, or pass --account-id)`,
    );
  }

  const where = describeRoute(inst.route, inst.workerName);
  if (target.question === 'choose') {
    steps.push(step('address', 'ask', 'Choose the address', 'a custom domain or workers.dev'));
    todo.push(
      'choose the address: pass --domain <host> or --workers-dev <name>, or answer the question',
    );
  } else if (target.question === 'confirm') {
    steps.push(
      step(
        'address',
        'ask',
        `Confirm the address: ${where}`,
        `found in ${paths.generatedConfig}; asked once`,
      ),
    );
    const flag =
      inst.route.kind === 'custom_domain'
        ? `--domain ${inst.route.domain}`
        : `--workers-dev ${inst.workerName}`;
    todo.push(`confirm the address (${flag}, or answer the question)`);
  } else {
    steps.push(step('address', 'skip', `Address ${where}`, `Worker ${inst.workerName}`));
  }

  if (target.write) {
    const why =
      target.source === 'recovered'
        ? `moves this instance's settings out of ${paths.generatedConfig}; nothing is re-created`
        : target.source === 'new'
          ? 'Worker name, address, sender and resource names (git-ignored)'
          : 'the settings changed';
    steps.push(step('instance', 'write', `Write ${paths.instanceFile}`, why));
  } else {
    steps.push(step('instance', 'skip', paths.instanceFile, 'unchanged'));
  }

  if (!input.secretsFileExists) {
    steps.push(
      step(
        'secrets-file',
        'write',
        `Create ${paths.secretsFile} from .secrets.example (mode 0600)`,
      ),
    );
  }

  if (login.length) {
    if (input.canAsk) {
      steps.push(
        step(
          'login',
          'ask',
          'Set up login (Discord, e-mail or both)',
          'the keys are checked, then stored; never shown',
        ),
      );
    } else {
      todo.push(
        ...login.map(
          (p) =>
            `${p} in ${paths.secretsFile} (or run without --yes in a terminal: the setup asks)`,
        ),
      );
    }
  } else {
    const methods = [
      has(secrets, 'DISCORD_CLIENT_ID') ? 'Discord' : null,
      has(secrets, 'RESEND_API_KEY') ? 'e-mail' : null,
    ].filter(Boolean);
    steps.push(
      step('login', 'skip', `Login: ${methods.join(' and ')}`, 'keys in the secrets file'),
    );
  }

  if (facts.d1) {
    const name = facts.d1.databaseName;
    const recorded = inst.d1.databaseId;
    if (remote?.d1DatabaseId) {
      steps.push(step('d1', 'skip', `D1 database ${name}`, `exists (${remote.d1DatabaseId})`));
    } else if (remote) {
      steps.push(step('d1', 'create', `D1 database ${name}`, `wrangler d1 create ${name}`));
    } else if (recorded) {
      steps.push(
        step('d1', 'skip', `D1 database ${name}`, `recorded by an earlier run (${recorded})`),
      );
    } else steps.push(step('d1', 'ensure', `D1 database ${name}`, 'create if missing'));
    if (remote?.d1DatabaseId && recorded && recorded !== remote.d1DatabaseId) {
      warnings.push(
        `${paths.instanceFile} recorded D1 id ${recorded}, but ${name} is ${remote.d1DatabaseId} now; ` +
          'the current one is used',
      );
    }
  }

  steps.push(
    step(
      'config',
      'write',
      `Write ${paths.generatedConfig}`,
      'the template environment with this instance and its ids filled in (git-ignored)',
    ),
  );

  if (facts.r2) {
    const name = facts.r2.bucketName;
    if (remote?.bucketExists) steps.push(step('r2', 'skip', `R2 bucket ${name}`, 'exists'));
    else if (remote) {
      steps.push(
        step('r2', 'create', `R2 bucket ${name} (private)`, `wrangler r2 bucket create ${name}`),
      );
    } else if (inst.r2.created) {
      steps.push(step('r2', 'skip', `R2 bucket ${name}`, 'recorded by an earlier run'));
    } else steps.push(step('r2', 'ensure', `R2 bucket ${name} (private)`, 'create if missing'));
  }

  for (const [id, kind, idKey, tokenKey, existing] of [
    ['sfu', 'Realtime SFU app', 'REALTIME_APP_ID', 'REALTIME_APP_TOKEN', remote?.sfuAppNames],
    ['turn', 'Realtime TURN key', 'TURN_KEY_ID', 'TURN_KEY_TOKEN', remote?.turnKeyNames],
  ] as const) {
    if (has(secrets, idKey) && has(secrets, tokenKey)) {
      steps.push(step(id, 'skip', `${kind}`, `${idKey} is in the secrets file`));
      continue;
    }
    steps.push(
      step(
        id,
        'create',
        `${kind} ${facts.workerName}`,
        `cf realtime ${id === 'sfu' ? 'sfu apps' : 'turn keys'} create; ${idKey} and ${tokenKey} go straight into the secrets file`,
      ),
    );
    if (existing?.includes(facts.workerName)) {
      warnings.push(
        `a ${kind} named ${facts.workerName} already exists, but its token is not in the secrets ` +
          'file and cannot be read again; a new one is created (delete the old one if unused)',
      );
    }
  }

  for (const [id, key, what] of [
    ['session-secret', 'SESSION_SECRET', '32 random bytes'],
    ['install-code', 'INSTALL_CODE', 'shown once at the end'],
  ] as const) {
    steps.push(
      has(secrets, key)
        ? step(id, 'skip', key, 'already in the secrets file')
        : step(id, 'write', `Generate ${key}`, what),
    );
  }

  const fileAccount = secrets.get('CLOUDFLARE_ACCOUNT_ID') ?? '';
  if (remote && fileAccount !== '' && fileAccount !== remote.accountId) {
    errors.push(
      `CLOUDFLARE_ACCOUNT_ID in the secrets file is ${fileAccount}, but wrangler is logged in to ` +
        `${remote.accountId}`,
    );
  }
  steps.push(
    fileAccount !== ''
      ? step('account-id', 'skip', 'CLOUDFLARE_ACCOUNT_ID', 'already in the secrets file')
      : step('account-id', 'write', 'Store CLOUDFLARE_ACCOUNT_ID', 'from wrangler whoami'),
  );

  const checked = [
    has(secrets, 'DISCORD_CLIENT_ID') || input.canAsk ? 'Discord app' : null,
    has(secrets, 'RESEND_API_KEY') || input.canAsk ? 'Resend key' : null,
    has(secrets, 'CLOUDFLARE_API_TOKEN') ? 'analytics token' : null,
  ].filter((x): x is string => x !== null);
  if (checked.length) {
    steps.push(
      step(
        'verify',
        'run',
        `Check the ${checked.join(', ')}`,
        'read-only calls; a refused key stops the deploy',
      ),
    );
  }

  steps.push(step('build', 'run', 'Build the web app', 'pnpm --filter @openlive/web build'));
  if (facts.d1) {
    steps.push(
      step(
        'migrations',
        'run',
        'Apply D1 migrations',
        `wrangler d1 migrations apply ${facts.d1.binding} --remote --env ${facts.env}`,
      ),
    );
  }

  // Everything the file will hold by deploy time: what is filled now plus what the setup adds.
  const uploadNames = new Set(filled.keys());
  for (const spec of SECRETS) {
    if (spec.source === 'generated' || spec.source === 'realtime' || spec.source === 'account') {
      uploadNames.add(spec.name);
    }
  }
  const known = new Set(SECRETS.map((s) => s.name));
  for (const name of filled.keys()) {
    if (!known.has(name)) warnings.push(`${name} is not a known secret; it is uploaded anyway`);
    if (name in facts.vars) errors.push(`${name} is both a var in wrangler.jsonc and a secret`);
  }
  for (const spec of SECRETS) {
    if (spec.source === 'optional' && !has(secrets, spec.name)) {
      warnings.push(`${spec.name} is empty, so this stays off: ${spec.description}`);
    }
  }
  if (!login.length) {
    if (!has(secrets, 'RESEND_API_KEY'))
      warnings.push('RESEND_API_KEY is empty: e-mail login stays off');
    if (!has(secrets, 'DISCORD_CLIENT_ID')) {
      warnings.push('DISCORD_CLIENT_ID is empty: Discord login stays off');
    }
  }
  if (has(secrets, 'RESEND_API_KEY') && !inst.emailFrom) {
    warnings.push(
      'no e-mail sender on a domain of yours (workers.dev): pass --email-from with a domain ' +
        "verified in Resend, or the magic link only reaches your own address (Resend's test sender)",
    );
  }
  if (input.metricsOff) {
    warnings.push(
      'metrics are off (--no-metrics): deployed without the Analytics Engine binding; run the ' +
        'setup again without the flag once Analytics Engine is enabled',
    );
  }
  if (facts.r2) {
    warnings.push('R2 needs an R2 subscription on the account, which may ask for a card');
  }

  const routes = [
    ...facts.customDomains.map((d) => `https://${d} (custom domain)`),
    ...(facts.workersDev ? [where] : []),
  ].join(', ');
  steps.push(
    step(
      'deploy',
      'run',
      `Deploy ${facts.workerName} to ${routes || 'no route'}`,
      'wrangler deploy --secrets-file: the secrets go in the same upload as the code, so no ' +
        'version without them ever takes traffic',
    ),
  );

  return { steps, errors, todo, warnings, uploadNames: [...uploadNames].sort() };
}

/** What a run that stopped half-way already did, for the message after a failure. */
export function describeProgress(done: readonly Step[]): string {
  const lines = done
    .filter(
      (s) =>
        s.action === 'create' ||
        s.action === 'ensure' ||
        s.action === 'write' ||
        s.id === 'migrations',
    )
    .map((s) => `  - ${s.title}`);
  return lines.length
    ? ['Already done in this run (kept; the next run continues from here):', ...lines].join('\n')
    : 'Nothing was created or written in this run.';
}

const MARK: Record<StepAction, string> = {
  ask: '?',
  create: '+',
  ensure: '*',
  skip: '=',
  write: '~',
  run: '>',
};

export function formatPlan(plan: Plan, header: string): string {
  const lines = [header, ''];
  plan.steps.forEach((s, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. [${MARK[s.action]}] ${s.title}`);
    if (s.detail) lines.push(`         ${s.detail}`);
  });
  lines.push(
    '',
    '  [+] create  [*] create if missing  [=] keep  [~] write locally  [>] run  [?] question',
  );
  lines.push('', `Secrets uploaded with the deploy (names only): ${plan.uploadNames.join(', ')}`);
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push('', title, ...items.map((m) => `  - ${m}`));
  };
  section('Errors (the setup refuses to run):', plan.errors);
  section('To answer or fill in (the real run asks, or stops here without a terminal):', plan.todo);
  section('Warnings:', plan.warnings);
  return lines.join('\n');
}
