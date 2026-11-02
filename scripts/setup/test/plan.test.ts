// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  computePlan,
  describeProgress,
  formatPlan,
  type PlanInput,
  type RemoteState,
} from '../src/plan.ts';
import { facts, instance, target } from './fixtures.ts';

const paths = {
  secretsFile: 'apps/api/.secrets.production',
  generatedConfig: 'apps/api/wrangler.production.generated.jsonc',
  instanceFile: 'apps/api/.instance.production.json',
};
const login = { DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'discord-secret-value' };
const complete = {
  ...login,
  SESSION_SECRET: 'session-secret-value',
  INSTALL_CODE: 'AAAA-BBBB-CCCC',
  REALTIME_APP_ID: 'app',
  REALTIME_APP_TOKEN: 'app-token-value',
  TURN_KEY_ID: 'turn',
  TURN_KEY_TOKEN: 'turn-token-value',
  CLOUDFLARE_ACCOUNT_ID: 'acc',
};
const remote = (o: Partial<RemoteState> = {}): RemoteState => ({
  accountId: 'acc',
  d1DatabaseId: null,
  bucketExists: false,
  workerExists: false,
  remoteSecretNames: [],
  sfuAppNames: [],
  turnKeyNames: [],
  ...o,
});
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  facts: facts(),
  target: target(),
  secrets: new Map(Object.entries(login)),
  secretsFileExists: true,
  remote: null,
  paths,
  ...o,
});
const actions = (p: ReturnType<typeof computePlan>) =>
  Object.fromEntries(p.steps.map((s) => [s.id, s.action]));

describe('computePlan', () => {
  it('dry run (no remote state): every step, resources as create-if-missing', () => {
    const plan = computePlan(input());
    expect(plan.steps.map((s) => s.id)).toEqual([
      'account',
      'address',
      'instance',
      'login',
      'd1',
      'config',
      'r2',
      'sfu',
      'turn',
      'session-secret',
      'install-code',
      'account-id',
      'verify',
      'build',
      'migrations',
      'deploy',
    ]);
    expect(actions(plan)).toMatchObject({
      account: 'run',
      address: 'skip',
      instance: 'skip',
      login: 'skip',
      d1: 'ensure',
      r2: 'ensure',
      sfu: 'create',
      turn: 'create',
    });
    expect(plan.errors).toEqual([]);
    expect(plan.todo).toEqual([]);
  });

  it('first real run: creates everything', () => {
    const plan = computePlan(input({ remote: remote() }));
    expect(actions(plan)).toMatchObject({
      account: 'skip',
      d1: 'create',
      r2: 'create',
      sfu: 'create',
      turn: 'create',
      'session-secret': 'write',
      'install-code': 'write',
      'account-id': 'write',
    });
    expect(plan.uploadNames).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'INSTALL_CODE',
      'REALTIME_APP_ID',
      'REALTIME_APP_TOKEN',
      'SESSION_SECRET',
      'TURN_KEY_ID',
      'TURN_KEY_TOKEN',
    ]);
  });

  it('second run is idempotent: keeps everything, still migrates and deploys', () => {
    const plan = computePlan(
      input({
        secrets: new Map(Object.entries(complete)),
        remote: remote({
          d1DatabaseId: 'db-id',
          bucketExists: true,
          workerExists: true,
          remoteSecretNames: ['SESSION_SECRET'],
        }),
      }),
    );
    const creating = plan.steps.filter((s) => s.action === 'create' || s.action === 'ensure');
    expect(creating).toEqual([]);
    expect(actions(plan)).toMatchObject({ migrations: 'run', deploy: 'run', config: 'write' });
  });

  it('adds a secrets-file step when the file is missing, and asks for a login method', () => {
    const plan = computePlan(input({ secrets: new Map(), secretsFileExists: false }));
    expect(plan.steps[3]).toMatchObject({ id: 'secrets-file', action: 'write' });
    expect(plan.todo).toHaveLength(1);
    expect(plan.errors).toEqual([]);
  });

  it('refuses DEV_AUTH anywhere', () => {
    const fromFile = computePlan(
      input({ secrets: new Map(Object.entries({ ...login, DEV_AUTH: '1' })) }),
    );
    expect(fromFile.errors.join()).toMatch(/secrets file sets DEV_AUTH/);
    const fromVars = computePlan(
      input({ facts: facts({ vars: { ...facts().vars, DEV_AUTH: '1' } }) }),
    );
    expect(fromVars.errors.join()).toMatch(/vars in wrangler.jsonc sets DEV_AUTH/);
    const fromRemote = computePlan(
      input({ remote: remote({ workerExists: true, remoteSecretNames: ['DEV_AUTH'] }) }),
    );
    expect(fromRemote.errors.join()).toMatch(/deployed Worker openlive has a DEV_AUTH secret/);
  });

  it('an empty DEV_AUTH placeholder in the file is not uploaded and not an error', () => {
    const plan = computePlan(
      input({ secrets: new Map(Object.entries({ ...login, DEV_AUTH: '' })) }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.uploadNames).not.toContain('DEV_AUTH');
  });

  it('refuses a secrets file for another account', () => {
    const plan = computePlan(
      input({ secrets: new Map(Object.entries(complete)), remote: remote({ accountId: 'other' }) }),
    );
    expect(plan.errors.join()).toMatch(/CLOUDFLARE_ACCOUNT_ID .* logged in to other/);
  });

  it('refuses a name that is both a var and a secret', () => {
    const plan = computePlan(
      input({ secrets: new Map(Object.entries({ ...login, APP_ORIGIN: 'https://x' })) }),
    );
    expect(plan.errors.join()).toMatch(/APP_ORIGIN is both a var/);
  });

  it('warns when a Realtime resource with the name exists but its token is not in the file', () => {
    const plan = computePlan(input({ remote: remote({ sfuAppNames: ['openlive'] }) }));
    expect(plan.warnings.join()).toMatch(/Realtime SFU app named openlive already exists/);
  });

  it('skips R2 and D1 steps when the environment has neither', () => {
    const plan = computePlan(input({ facts: facts({ d1: null, r2: null }) }));
    expect(plan.steps.map((s) => s.id)).not.toContain('d1');
    expect(plan.steps.map((s) => s.id)).not.toContain('r2');
    expect(plan.steps.map((s) => s.id)).not.toContain('migrations');
  });
});

describe('computePlan: address and instance', () => {
  it('a recovered instance asks once to confirm the address, and moves its settings', () => {
    const plan = computePlan(
      input({ target: target({ source: 'recovered', question: 'confirm', write: true }) }),
    );
    expect(actions(plan)).toMatchObject({ address: 'ask', instance: 'write' });
    expect(plan.todo.join()).toMatch(/--domain openlive\.example\.com/);
    expect(plan.steps.find((s) => s.id === 'instance')?.detail).toMatch(/nothing is re-created/);
  });

  it('no address yet: asks, and does not judge APP_ORIGIN', () => {
    const plan = computePlan(
      input({
        target: target({ source: 'new', question: 'choose', write: true }),
        facts: facts({ vars: {} }),
      }),
    );
    expect(actions(plan)).toMatchObject({ address: 'ask' });
    expect(plan.errors).toEqual([]);
    expect(plan.todo.join()).toMatch(/--domain <host> or --workers-dev <name>/);
  });

  it('carries the target errors (a rename) and notes (an address change)', () => {
    const plan = computePlan(
      input({ target: target({ errors: ['never renames'], notes: ['the address changes'] }) }),
    );
    expect(plan.errors).toContain('never renames');
    expect(plan.warnings).toContain('the address changes');
  });

  it('refuses an instance file of another account', () => {
    const plan = computePlan(
      input({
        target: target({ instance: instance({ accountId: 'acc-a' }) }),
        remote: remote({ accountId: 'acc-b' }),
      }),
    );
    expect(plan.errors.join()).toMatch(/belongs to account acc-a.*acc-b/);
  });

  it('missing login: the assistant asks in a terminal, otherwise it is a to-do', () => {
    const asked = computePlan(input({ secrets: new Map(), canAsk: true }));
    expect(actions(asked)).toMatchObject({ login: 'ask' });
    expect(asked.todo).toEqual([]);
    const notAsked = computePlan(input({ secrets: new Map(), canAsk: false }));
    expect(notAsked.todo.join()).toMatch(/no login method/);
  });

  it('checks the keys that are present before the deploy', () => {
    const plan = computePlan(
      input({
        secrets: new Map(Object.entries({ RESEND_API_KEY: 're_x', CLOUDFLARE_API_TOKEN: 't' })),
      }),
    );
    expect(plan.steps.find((s) => s.id === 'verify')?.title).toBe(
      'Check the Resend key, analytics token',
    );
  });

  it('--no-metrics is a warning, not an error', () => {
    const plan = computePlan(input({ metricsOff: true }));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.join()).toMatch(/metrics are off \(--no-metrics\)/);
  });

  it('warns that workers.dev e-mail needs a sender on a verified domain', () => {
    const plan = computePlan(
      input({
        target: target({ instance: instance({ route: { kind: 'workers_dev' }, emailFrom: null }) }),
        facts: facts({
          customDomains: [],
          workersDev: true,
          vars: { APP_ORIGIN: 'https://openlive.your-subdomain.workers.dev' },
        }),
        secrets: new Map(Object.entries({ RESEND_API_KEY: 're_x' })),
      }),
    );
    expect(plan.warnings.join()).toMatch(/--email-from/);
    expect(plan.steps.at(-1)?.title).toMatch(/openlive\.your-subdomain\.workers\.dev/);
  });
});

describe('computePlan: partial state (a run that failed half-way)', () => {
  const recorded = (o: Partial<ReturnType<typeof instance>> = {}) =>
    target({ instance: instance({ accountId: 'acc', ...o }) });

  it('dry run after the D1 database was created: kept from the instance file', () => {
    const plan = computePlan(
      input({ target: recorded({ d1: { databaseName: 'openlive', databaseId: 'db-1' } }) }),
    );
    expect(actions(plan)).toMatchObject({ d1: 'skip', r2: 'ensure', sfu: 'create' });
    expect(plan.steps.find((s) => s.id === 'd1')?.detail).toMatch(/recorded.*db-1/);
  });

  it('D1 and R2 done, the SFU app created, the TURN key not: only the TURN key is created', () => {
    const secrets = new Map(
      Object.entries({ ...login, REALTIME_APP_ID: 'app', REALTIME_APP_TOKEN: 'app-token-value' }),
    );
    const plan = computePlan(
      input({
        secrets,
        target: recorded({
          d1: { databaseName: 'openlive', databaseId: 'db-1' },
          r2: { bucketName: 'openlive-thumbnails', created: true },
        }),
        remote: remote({ d1DatabaseId: 'db-1', bucketExists: true, turnKeyNames: [] }),
      }),
    );
    const creating = plan.steps.filter((s) => s.action === 'create').map((s) => s.id);
    expect(creating).toEqual(['turn']);
    expect(actions(plan)).toMatchObject({
      sfu: 'skip',
      'session-secret': 'write',
      'install-code': 'write',
    });
    expect(plan.errors).toEqual([]);
  });

  it('a failed deploy: everything exists, the rerun only builds, migrates and deploys', () => {
    const plan = computePlan(
      input({
        secrets: new Map(Object.entries(complete)),
        target: recorded({
          d1: { databaseName: 'openlive', databaseId: 'db-1' },
          r2: { bucketName: 'openlive-thumbnails', created: true },
        }),
        remote: remote({ d1DatabaseId: 'db-1', bucketExists: true }),
      }),
    );
    const changing = plan.steps.filter((s) => s.action !== 'skip').map((s) => s.id);
    expect(changing).toEqual(['config', 'verify', 'build', 'migrations', 'deploy']);
  });

  it('a recorded resource deleted by hand since: the account wins, it is created again', () => {
    const plan = computePlan(
      input({
        target: recorded({
          d1: { databaseName: 'openlive', databaseId: 'db-old' },
          r2: { bucketName: 'openlive-thumbnails', created: true },
        }),
        remote: remote({ d1DatabaseId: null, bucketExists: false }),
      }),
    );
    // Deleted by hand since: created again.
    expect(actions(plan)).toMatchObject({ d1: 'create', r2: 'create' });
  });

  it('describeProgress lists what a failed run already did', () => {
    const plan = computePlan(input({ remote: remote() }));
    const done = plan.steps.filter((s) => ['account', 'instance', 'd1', 'config'].includes(s.id));
    const text = describeProgress(done);
    expect(text).toContain('D1 database openlive');
    expect(text).toContain('Write apps/api/wrangler.production.generated.jsonc');
    expect(text).not.toContain('Cloudflare account');
    expect(describeProgress([])).toMatch(/Nothing was created/);
  });
});

describe('formatPlan', () => {
  it('lists the steps and never prints a secret value', () => {
    const text = formatPlan(
      computePlan(input({ secrets: new Map(Object.entries(complete)), remote: remote() })),
      'header',
    );
    expect(text).toContain('Deploy openlive to https://openlive.example.com (custom domain)');
    for (const v of Object.values(complete).filter((v) => v.length > 5))
      expect(text).not.toContain(v);
  });
});
