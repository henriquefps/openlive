// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm run setup`: the self-host setup (docs/self-host.md).

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as api from './api.ts';
import { ArgsError, parseCliArgs, USAGE } from './args.ts';
import {
  ANALYTICS_INSTRUCTIONS,
  discordInstructions,
  emailInstructions,
  parseLoginChoice,
  senderDomain,
} from './assistant.ts';
import * as cloud from './cloudflare.ts';
import {
  analyticsEngineNotEnabled,
  analyticsEngineUrl,
  ConfigError,
  readEnvFacts,
  renderInstanceConfig,
  type RenderOptions,
} from './config.ts';
import { readBuildInfo } from './build-info.ts';
import { originOf, validHostname, validWorkerName, zoneCandidates } from './domain.ts';
import { devAuthProblems } from './guard.ts';
import {
  type Instance,
  InstanceError,
  parseInstance,
  patchTarget,
  recoverFromGenerated,
  resolveTarget,
  serializeInstance,
  type Target,
} from './instance.ts';
import { computePlan, describeProgress, formatPlan, type RemoteState, type Step } from './plan.ts';
import * as pre from './preflight.ts';
import { ask, askHidden, interactive } from './prompt.ts';
import { filledSecrets, parseSecretsFile, SecretsFileError, setSecret } from './secrets-file.ts';
import { generateInstallCode, generateSessionSecret } from './secrets.ts';

class Stop extends Error {}

const repoRoot = resolve(import.meta.dirname, '../../..');
const apiDir = join(repoRoot, 'apps', 'api');
const setupDir = join(repoRoot, 'scripts', 'setup');
const rel = (p: string) => relative(repoRoot, p);

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!interactive()) throw new Stop('no terminal to confirm in: run again with --yes');
  const answer = await ask(`${question} [y/N] `);
  if (!/^y(es)?$/i.test(answer)) throw new Stop('stopped: nothing else was changed');
}

function pickAccount(accounts: cloud.Account[], wanted: string | undefined): string {
  if (wanted) {
    if (!accounts.some((a) => a.id === wanted))
      throw new Stop(`account ${wanted} is not available to this login`);
    return wanted;
  }
  const [only] = accounts;
  if (accounts.length === 1 && only) return only.id;
  const list = accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n');
  throw new Stop(
    `this login has ${accounts.length} accounts; pick one with --account-id:\n${list}`,
  );
}

async function probe<T>(fn: () => T | Promise<T>): Promise<pre.Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The address question: once for an address recovered from an older setup, or a new one. */
async function askAddress(target: Target): Promise<{ domain?: string; workersDev?: string }> {
  const inst = target.instance;
  if (target.question === 'confirm') {
    const current =
      inst.route.kind === 'custom_domain' ? inst.route.domain : `workers.dev (${inst.workerName})`;
    const answer = await ask(
      `Address of this instance [${current}] (Enter keeps it, or type another domain): `,
    );
    if (answer === '') {
      return inst.route.kind === 'custom_domain'
        ? { domain: inst.route.domain }
        : { workersDev: inst.workerName };
    }
    if (!validHostname(answer.toLowerCase())) throw new Stop(`${answer} is not a host name`);
    return { domain: answer.toLowerCase() };
  }
  console.log(
    [
      '',
      'Where will people open Openlive?',
      '  1. A domain of yours whose zone is in this Cloudflare account (e.g. live.example.com)',
      '  2. A free <name>.<your-subdomain>.workers.dev address (no domain needed)',
    ].join('\n'),
  );
  const choice = await ask('Choose 1 or 2: ');
  if (choice === '1') {
    const domain = (await ask('Domain (host name only): ')).toLowerCase();
    if (!validHostname(domain)) throw new Stop(`${domain} is not a host name`);
    return { domain };
  }
  if (choice === '2') {
    const name = (await ask(`Worker name [${inst.workerName}]: `)).toLowerCase() || inst.workerName;
    if (!validWorkerName(name)) throw new Stop(`${name} is not a valid Worker name`);
    return { workersDev: name };
  }
  throw new Stop('no address chosen: run again, or pass --domain <host> / --workers-dev <name>');
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.env === 'dev') throw new Stop('dev is local only (`pnpm --filter @openlive/api dev`)');

  const configPath = join(apiDir, 'wrangler.jsonc');
  const secretsPath = join(apiDir, `.secrets.${args.env}`);
  const examplePath = join(apiDir, '.secrets.example');
  const generatedPath = join(apiDir, `wrangler.${args.env}.generated.jsonc`);
  const instancePath = join(apiDir, `.instance.${args.env}.json`);
  const paths = {
    secretsFile: rel(secretsPath),
    generatedConfig: rel(generatedPath),
    instanceFile: rel(instancePath),
  };

  const configText = readFileSync(configPath, 'utf8');
  const secretsFileExists = existsSync(secretsPath);
  let secretsText = readFileSync(secretsFileExists ? secretsPath : examplePath, 'utf8');
  let secrets = parseSecretsFile(secretsText);
  const has = (k: string) => (secrets.get(k) ?? '') !== '';

  const fromFile = existsSync(instancePath)
    ? parseInstance(readFileSync(instancePath, 'utf8'), paths.instanceFile)
    : null;
  const recovered =
    !fromFile && existsSync(generatedPath)
      ? recoverFromGenerated(
          readFileSync(generatedPath, 'utf8'),
          args.env,
          has('REALTIME_APP_ID') || has('CLOUDFLARE_ACCOUNT_ID'),
        )
      : null;
  let target = resolveTarget(args, fromFile, recovered);

  // Every value the setup knows is masked in the output of the tools it runs.
  const extraSecrets: string[] = [];
  const redact = (text: string) => {
    let out = text;
    for (const v of [...filledSecrets(secrets).values(), ...extraSecrets])
      if (v.length >= 6) out = out.split(v).join('<redacted>');
    return out;
  };
  const tools: cloud.Tools = { apiDir, repoRoot, env: {}, redact };

  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    packageManager?: string;
  };
  const localChecks = [
    pre.checkNode(process.versions.node, (rootPkg.engines?.node ?? '>=26').replace(/^>=\s*/, '')),
    pre.checkPnpm(cloud.pnpmVersion(repoRoot), rootPkg.packageManager?.split('@')[1] ?? '12'),
    pre.checkDeps(
      existsSync(join(apiDir, 'node_modules', '.bin', 'wrangler')) &&
        existsSync(join(setupDir, 'node_modules', '.bin', 'cf')),
    ),
  ];
  const needsRealtime = () => !has('REALTIME_APP_ID') || !has('TURN_KEY_ID');

  const facts = (t: Target, ids: { accountId: string | null; databaseId: string | null }) =>
    readEnvFacts(renderInstanceConfig(configText, args.env, t.instance, ids), args.env);
  const header = (dry: boolean) =>
    `Openlive setup: env ${args.env}, Worker ${target.instance.workerName}` +
    `${dry ? ' (dry run: Cloudflare was not queried, nothing was written)' : ''}`;
  const sourceNote = () =>
    target.source === 'recovered'
      ? `Found an instance set up by an earlier version of the setup (${paths.generatedConfig}).`
      : target.source === 'file'
        ? `Instance settings: ${paths.instanceFile}.`
        : 'New instance.';

  if (args.dryRun) {
    const checks = [
      ...localChecks,
      pre.checkWrangler(null),
      pre.checkCf(null, needsRealtime()),
      pre.checkR2(null),
      pre.checkAddress(target.instance.route, null, null),
    ];
    const plan = computePlan({
      facts: facts(target, {
        accountId: target.instance.accountId,
        databaseId: target.instance.d1.databaseId,
      }),
      target,
      secrets,
      secretsFileExists,
      remote: null,
      paths,
      canAsk: interactive() && !args.yes,
      metricsOff: args.noMetrics,
    });
    console.log([header(true), sourceNote(), '', pre.formatChecks(checks), ''].join('\n'));
    console.log(formatPlan(plan, 'Plan:'));
    if (plan.errors.length || pre.failed(checks).length) process.exitCode = 1;
    return;
  }

  // Local refusals come first, before any call to Cloudflare.
  if (pre.failed(localChecks).length) {
    console.log(pre.formatChecks(localChecks));
    throw new Stop('fix the failed checks above and run again');
  }
  if (target.errors.length) throw new Stop(target.errors.join('; '));

  const wranglerProbe = await probe(() => cloud.whoami(tools));
  if (!wranglerProbe.ok) {
    console.log(pre.formatChecks([...localChecks, pre.checkWrangler(wranglerProbe)]));
    throw new Stop('fix the failed checks above and run again');
  }
  const accountId = pickAccount(wranglerProbe.value, args.accountId);
  tools.env['CLOUDFLARE_ACCOUNT_ID'] = accountId;
  const token = cloud.authToken(tools);
  extraSecrets.push(token);
  const client: api.CfClient = { fetch, token };

  // A new environment whose Worker is already deployed (an instance set up elsewhere): its
  // custom domain is the default answer.
  if (target.question === 'choose') {
    const domains = await api.workerDomains(client, accountId, target.instance.workerName);
    if (domains[0]) target = resolveTarget(args, fromFile, recovered, domains[0]);
  }
  if (target.question && !args.check) {
    if (!interactive() || args.yes) {
      throw new Stop(
        target.question === 'confirm'
          ? `confirm the address of this instance: pass ${
              target.instance.route.kind === 'custom_domain'
                ? `--domain ${target.instance.route.domain}`
                : `--workers-dev ${target.instance.workerName}`
            }`
          : 'choose the address: pass --domain <host> or --workers-dev <name>',
      );
    }
    const answer = await askAddress(target);
    target = resolveTarget({ ...args, ...answer }, fromFile, recovered);
    if (target.errors.length) throw new Stop(target.errors.join('; '));
  }

  const route = target.instance.route;
  const zones =
    route.kind === 'custom_domain'
      ? await probe(() => api.findZones(client, accountId, zoneCandidates(route.domain)))
      : null;
  const subdomain =
    route.kind === 'workers_dev'
      ? await probe(() => api.workersSubdomain(client, accountId))
      : null;
  const checks = [
    ...localChecks,
    pre.checkWrangler({ ok: true, value: { accounts: wranglerProbe.value.length } }),
    pre.checkCf(
      needsRealtime() ? await probe(() => cloud.cfLoggedIn(tools) || fail('not logged in')) : null,
      needsRealtime(),
    ),
    pre.checkR2(await probe(() => api.r2State(client, accountId))),
    target.question
      ? { id: 'address', title: 'Address', status: 'skip' as const, detail: 'not chosen yet' }
      : pre.checkAddress(route, zones, subdomain),
  ];
  console.log(['', pre.formatChecks(checks), ''].join('\n'));
  if (pre.failed(checks).length) throw new Stop('fix the failed checks above and run again');
  if (args.check) {
    console.log('All checks passed.');
    return;
  }

  target = patchTarget(target, fromFile, {
    accountId: target.instance.accountId ?? accountId,
    ...(subdomain?.ok && subdomain.value
      ? { route: { kind: 'workers_dev' as const, subdomain: subdomain.value } }
      : {}),
  });

  const remoteSecrets = cloud.workerSecretNames(tools, target.instance.workerName);
  const remote: RemoteState = {
    accountId,
    d1DatabaseId: cloud.d1DatabaseId(tools, target.instance.d1.databaseName),
    bucketExists: cloud.r2BucketExists(tools, target.instance.r2.bucketName),
    workerExists: remoteSecrets !== null,
    remoteSecretNames: remoteSecrets ?? [],
    sfuAppNames: !has('REALTIME_APP_ID') ? cloud.realtimeNames(tools, 'sfu') : null,
    turnKeyNames: !has('TURN_KEY_ID') ? cloud.realtimeNames(tools, 'turn') : null,
  };
  // What exists is recorded, so a later dry run shows it as kept.
  target = patchTarget(target, fromFile, {
    d1: { ...target.instance.d1, databaseId: remote.d1DatabaseId ?? target.instance.d1.databaseId },
    r2: { ...target.instance.r2, created: remote.bucketExists || target.instance.r2.created },
  });

  const canAsk = interactive() && !args.yes;
  const plan = computePlan({
    facts: facts(target, { accountId, databaseId: remote.d1DatabaseId }),
    target,
    secrets,
    secretsFileExists,
    remote,
    paths,
    canAsk,
    metricsOff: args.noMetrics,
  });
  console.log([header(false), sourceNote(), ''].join('\n'));
  console.log(formatPlan(plan, 'Plan:'));
  console.log('');
  if (plan.errors.length) throw new Stop('fix the errors above and run again');
  if (plan.todo.length) {
    if (!secretsFileExists) {
      writeFileSync(secretsPath, secretsText, { mode: 0o600 });
      console.log(`Wrote ${paths.secretsFile} from the template.`);
    }
    throw new Stop(`fill in ${paths.secretsFile} (see the list above) and run again`);
  }

  const writeSecrets = () => {
    writeFileSync(secretsPath, secretsText, { mode: 0o600 });
    chmodSync(secretsPath, 0o600);
    secrets = parseSecretsFile(secretsText);
  };
  const put = (key: string, value: string) => {
    secretsText = setSecret(secretsText, key, value);
    writeSecrets();
  };
  const inst = (): Instance => target.instance;
  const saveInstance = () => {
    writeFileSync(instancePath, serializeInstance(inst()));
    target = { ...target, source: 'file', write: false };
  };

  let databaseId = remote.d1DatabaseId;
  let metricsFellBack = false;
  const build = readBuildInfo(repoRoot);
  const renderGenerated = (opts: RenderOptions) =>
    renderInstanceConfig(
      configText,
      args.env,
      inst(),
      { accountId, databaseId },
      { build, ...opts },
    );
  let installCode: string | null = null;
  const verified = new Set<string>();
  const done: Step[] = [];

  const report = (name: string, v: api.Validation) => {
    console.log(`  ${name}: ${v.status === 'valid' ? 'ok' : v.status}, ${v.detail}`);
    for (const w of v.warnings) console.log(`    ! ${w}`);
  };

  const loginAssistant = async () => {
    const origin = originOf(inst().route, inst().workerName);
    console.log(
      [
        '',
        'People sign in with Discord, with an e-mail link (Resend), or both.',
        '  1. Discord  2. E-mail  3. Both',
      ].join('\n'),
    );
    let methods = parseLoginChoice(await ask('Choose [3]: '));
    while (!methods) methods = parseLoginChoice(await ask('Type 1, 2 or 3: '));
    if (methods.includes('discord')) {
      console.log(`\n${discordInstructions(origin)}\n`);
      for (let attempt = 1; ; attempt++) {
        const id = await ask('Discord Client ID: ');
        const secret = await askHidden('Discord Client Secret (hidden): ');
        if (!id || !secret) throw new Stop('the Discord client id and secret are both needed');
        const v = await api.verifyDiscordApp(fetch, id, secret);
        report('Discord app', v);
        if (v.status !== 'invalid') {
          put('DISCORD_CLIENT_ID', id);
          put('DISCORD_CLIENT_SECRET', secret);
          verified.add('discord');
          break;
        }
        if (attempt === 3) throw new Stop('Discord refused the client id and secret three times');
      }
    }
    if (methods.includes('email')) {
      console.log(`\n${emailInstructions(inst().emailFrom)}\n`);
      for (let attempt = 1; ; attempt++) {
        const key = await askHidden('Resend API key (hidden): ');
        if (!key) throw new Stop('the Resend API key is needed for e-mail login');
        const v = await api.verifyResendKey(fetch, key, senderDomain(inst().emailFrom));
        report('Resend key', v);
        if (v.status !== 'invalid') {
          put('RESEND_API_KEY', key);
          verified.add('resend');
          break;
        }
        if (attempt === 3) throw new Stop('Resend refused the key three times');
      }
    }
    if (!has('CLOUDFLARE_API_TOKEN')) {
      console.log(`\n${ANALYTICS_INSTRUCTIONS}\n`);
      const t = await askHidden('Analytics token (hidden, Enter skips): ');
      if (t) {
        const v = await api.verifyAnalyticsToken(fetch, t, accountId);
        report('Analytics token', v);
        if (v.status === 'invalid')
          console.log('  Not stored; add it later and run the setup again.');
        else {
          put('CLOUDFLARE_API_TOKEN', t);
          verified.add('analytics');
        }
      }
    }
  };

  const verify = async () => {
    const problems: string[] = [];
    const run = async (key: string, name: string, check: () => Promise<api.Validation>) => {
      if (verified.has(key)) return;
      const v = await check();
      report(name, v);
      if (v.status === 'invalid') problems.push(`${name}: ${v.detail}`);
    };
    const s = (k: string) => secrets.get(k) ?? '';
    if (has('DISCORD_CLIENT_ID')) {
      await run('discord', 'Discord app', () =>
        api.verifyDiscordApp(fetch, s('DISCORD_CLIENT_ID'), s('DISCORD_CLIENT_SECRET')),
      );
    }
    if (has('RESEND_API_KEY')) {
      await run('resend', 'Resend key', () =>
        api.verifyResendKey(fetch, s('RESEND_API_KEY'), senderDomain(inst().emailFrom)),
      );
    }
    if (has('CLOUDFLARE_API_TOKEN')) {
      await run('analytics', 'Analytics token', () =>
        api.verifyAnalyticsToken(fetch, s('CLOUDFLARE_API_TOKEN'), accountId),
      );
    }
    if (problems.length) {
      throw new Stop(
        `not deploying with a refused key: ${problems.join('; ')}. Fix it in ${paths.secretsFile} and run again`,
      );
    }
  };

  const runStep = async (s: Step) => {
    if (s.action === 'skip') return;
    if (s.action === 'create' || s.id === 'migrations' || s.id === 'deploy') {
      await confirm(`${s.action === 'create' ? 'Create' : 'Run:'} ${s.title}?`, args.yes);
    }
    switch (s.id) {
      case 'instance':
        saveInstance();
        break;
      case 'secrets-file':
        writeSecrets();
        break;
      case 'login':
        await loginAssistant();
        break;
      case 'd1': {
        databaseId = cloud.d1Create(tools, inst().d1.databaseName);
        target = { ...target, instance: { ...inst(), d1: { ...inst().d1, databaseId } } };
        saveInstance();
        break;
      }
      case 'config':
        if (!databaseId) throw new Stop(`no id for the D1 database ${inst().d1.databaseName}`);
        writeFileSync(generatedPath, renderGenerated({ metrics: !args.noMetrics }));
        break;
      case 'r2':
        cloud.r2Create(tools, inst().r2.bucketName);
        target = { ...target, instance: { ...inst(), r2: { ...inst().r2, created: true } } };
        saveInstance();
        break;
      case 'sfu':
      case 'turn': {
        // Written before anything else can fail: the token can't be read again.
        const { id, token: secret } = cloud.realtimeCreate(tools, s.id, inst().workerName);
        put(s.id === 'sfu' ? 'REALTIME_APP_ID' : 'TURN_KEY_ID', id);
        put(s.id === 'sfu' ? 'REALTIME_APP_TOKEN' : 'TURN_KEY_TOKEN', secret);
        break;
      }
      case 'session-secret':
        put('SESSION_SECRET', generateSessionSecret());
        break;
      case 'install-code':
        installCode = generateInstallCode();
        put('INSTALL_CODE', installCode);
        break;
      case 'account-id':
        put('CLOUDFLARE_ACCOUNT_ID', accountId);
        break;
      case 'verify':
        await verify();
        break;
      case 'build':
        cloud.buildWeb(tools);
        break;
      case 'migrations': {
        const d1 = facts(target, { accountId, databaseId }).d1;
        if (d1) cloud.applyMigrations(tools, generatedPath, args.env, d1.binding);
        break;
      }
      case 'deploy':
        deploy();
        break;
      case 'account':
      case 'address':
        break;
    }
    done.push(s);
    console.log(`done: ${s.title}`);
  };

  const deploy = () => {
    // The file is read again and checked again right before the upload.
    const toUpload = filledSecrets(parseSecretsFile(readFileSync(secretsPath, 'utf8')));
    const envFacts = facts(target, { accountId, databaseId });
    const problems = devAuthProblems(envFacts, toUpload.keys(), remote.remoteSecretNames);
    if (problems.length) throw new Stop(`refusing to deploy: ${problems.join('; ')}`);
    const dir = mkdtempSync(join(tmpdir(), 'openlive-setup-'));
    try {
      const file = join(dir, 'secrets.json');
      writeFileSync(file, JSON.stringify(Object.fromEntries(toUpload)), { mode: 0o600 });
      let r = cloud.deploy(tools, generatedPath, args.env, file);
      if (r.status !== 0 && !args.noMetrics && analyticsEngineNotEnabled(r.stdout + r.stderr)) {
        // The account has not opted in to Analytics Engine: deploy without metrics rather than
        // not at all. The next run renders the binding again and tries with it.
        console.log(
          [
            '',
            'Analytics Engine is not enabled on this account (wrangler error 10089).',
            `Enable it: open ${analyticsEngineUrl(accountId)} and create a dataset there (any`,
            "name; the opt-in only takes effect once one exists). Until then Openlive's metrics",
            'are off. Deploying again without the metrics binding...',
            '',
          ].join('\n'),
        );
        writeFileSync(generatedPath, renderGenerated({ metrics: false }));
        r = cloud.deploy(tools, generatedPath, args.env, file);
        if (r.status === 0) metricsFellBack = true;
      }
      if (r.status !== 0) throw new cloud.CommandError(`wrangler deploy failed (exit ${r.status})`);
      console.log(`\nOpenlive is deployed: ${originOf(inst().route, inst().workerName)}`);
      if (metricsFellBack) {
        console.log(
          'Warning: metrics are off until Analytics Engine is enabled; run the setup again later.',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    for (const s of plan.steps) await runStep(s);
  } catch (err) {
    console.error(`\n${describeProgress(done)}`);
    console.error('Run the same command again: it keeps what exists and continues.');
    throw err;
  }

  console.log(`Sign in at ${originOf(inst().route, inst().workerName)}`);
  if (installCode) {
    console.log(
      `\nInstall code (shown once; sign in and enter it to become the admin): ${installCode}`,
    );
    // Sign-up stays open until the claim.
    console.log('Claim it now: until then, anyone who finds the address can sign up.');
  } else {
    console.log(`\nThe install code is unchanged (INSTALL_CODE in ${paths.secretsFile}).`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

main().catch((err: unknown) => {
  if (
    err instanceof Stop ||
    err instanceof ArgsError ||
    err instanceof ConfigError ||
    err instanceof InstanceError ||
    err instanceof SecretsFileError ||
    err instanceof cloud.CommandError ||
    err instanceof api.ApiError
  ) {
    console.error(`setup: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
