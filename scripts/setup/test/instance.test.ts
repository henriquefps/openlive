// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderInstanceConfig, readEnvFacts } from '../src/config.ts';
import {
  InstanceError,
  parseInstance,
  patchTarget,
  recoverFromGenerated,
  resolveTarget,
  serializeInstance,
} from '../src/instance.ts';
import { instance, legacyGenerated, realConfig } from './fixtures.ts';

describe('parseInstance / serializeInstance', () => {
  it('round-trips', () => {
    const inst = instance({ accountId: 'acc', d1: { databaseName: 'openlive', databaseId: 'db' } });
    expect(parseInstance(serializeInstance(inst), 'f')).toEqual(inst);
  });

  it('rejects broken files with the file name', () => {
    expect(() => parseInstance('{', 'apps/api/.instance.production.json')).toThrow(
      /\.instance\.production\.json is not valid JSON/,
    );
    expect(() => parseInstance('{"version":2}', 'f')).toThrow(InstanceError);
    const bad = JSON.parse(serializeInstance(instance())) as Record<string, unknown>;
    bad['route'] = { kind: 'custom_domain', domain: 'https://x.example.com' };
    expect(() => parseInstance(JSON.stringify(bad), 'f')).toThrow(/route.domain/);
  });
});

describe('recoverFromGenerated (an instance set up before .instance.<env>.json)', () => {
  it('finds the Worker, address, sender, account and existing resource ids', () => {
    const inst = recoverFromGenerated(legacyGenerated, 'production', true);
    expect(inst).toEqual({
      version: 1,
      workerName: 'openlive',
      route: { kind: 'custom_domain', domain: 'live.example.org' },
      emailFrom: 'Openlive <login@live.example.org>',
      accountId: 'acc-legacy',
      d1: { databaseName: 'openlive', databaseId: '00000000-0000-0000-0000-000000000001' },
      r2: { bucketName: 'openlive-thumbnails', created: true },
    });
  });

  it('does not claim the bucket when the old run stopped before creating it', () => {
    expect(recoverFromGenerated(legacyGenerated, 'production', false)?.r2.created).toBe(false);
  });

  it('a placeholder D1 id is not an id', () => {
    const text = legacyGenerated.replace(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000000',
    );
    expect(recoverFromGenerated(text, 'production', true)?.d1.databaseId).toBeNull();
  });

  it('a workers.dev instance keeps its subdomain', () => {
    const text = legacyGenerated
      .replace('"routes": [{ "pattern": "live.example.org", "custom_domain": true }],', '')
      .replace('"workers_dev": false', '"workers_dev": true')
      .replace(
        '"APP_ORIGIN": "https://live.example.org"',
        '"APP_ORIGIN": "https://openlive.acme.workers.dev"',
      );
    expect(recoverFromGenerated(text, 'production', true)?.route).toEqual({
      kind: 'workers_dev',
      subdomain: 'acme',
    });
  });

  it('returns null for another environment or garbage', () => {
    expect(recoverFromGenerated(legacyGenerated, 'staging', true)).toBeNull();
    expect(recoverFromGenerated('{', 'production', true)).toBeNull();
  });

  it('rendering the recovered instance gives back the same deployed environment', () => {
    const inst = recoverFromGenerated(legacyGenerated, 'production', true);
    if (!inst) throw new Error('not recovered');
    const out = renderInstanceConfig(realConfig, 'production', inst, {
      accountId: inst.accountId,
      databaseId: inst.d1.databaseId,
    });
    const before = readEnvFacts(legacyGenerated, 'production');
    const after = readEnvFacts(out, 'production');
    for (const key of [
      'workerName',
      'customDomains',
      'workersDev',
      'accountId',
      'd1',
      'r2',
    ] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after.vars['APP_ORIGIN']).toBe(before.vars['APP_ORIGIN']);
    expect(after.vars['EMAIL_FROM']).toBe(before.vars['EMAIL_FROM']);
  });
});

describe('resolveTarget', () => {
  const env = 'production';

  it('a new instance without flags asks for the address', () => {
    const t = resolveTarget({ env }, null, null);
    expect(t).toMatchObject({ source: 'new', question: 'choose', write: true, errors: [] });
    expect(t.instance.workerName).toBe('openlive');
  });

  it('a new instance with --domain: default names and sender', () => {
    const t = resolveTarget({ env: 'staging', domain: 'live.example.com' }, null, null);
    expect(t.question).toBeNull();
    expect(t.instance).toMatchObject({
      workerName: 'openlive-staging',
      route: { kind: 'custom_domain', domain: 'live.example.com' },
      emailFrom: 'Openlive <login@live.example.com>',
      d1: { databaseName: 'openlive-staging', databaseId: null },
      r2: { bucketName: 'openlive-staging-thumbnails', created: false },
    });
  });

  it('a new instance with --workers-dev: the name is the Worker, no default sender', () => {
    const t = resolveTarget({ env: 'test', workersDev: 'openlive-test' }, null, null);
    expect(t.instance).toMatchObject({
      workerName: 'openlive-test',
      route: { kind: 'workers_dev' },
      emailFrom: null,
    });
  });

  it('a recovered instance asks once to confirm its address, unless the flag answers it', () => {
    const recovered = recoverFromGenerated(legacyGenerated, env, true);
    const asked = resolveTarget({ env }, null, recovered);
    expect(asked).toMatchObject({ source: 'recovered', question: 'confirm', write: true });
    const answered = resolveTarget({ env, domain: 'live.example.org' }, null, recovered);
    expect(answered.question).toBeNull();
    expect(answered.notes).toEqual([]);
    // Nothing about the existing resources changes.
    expect(answered.instance).toEqual(recovered);
  });

  it('an instance file needs no question and no write when nothing changes', () => {
    const file = instance({ accountId: 'acc' });
    expect(resolveTarget({ env }, file, null)).toMatchObject({
      source: 'file',
      question: null,
      write: false,
    });
    expect(resolveTarget({ env, domain: 'openlive.example.com' }, file, null).write).toBe(false);
  });

  it('a new address is a change: noted, and the default sender follows it', () => {
    const t = resolveTarget({ env, domain: 'new.example.net' }, instance(), null);
    expect(t.write).toBe(true);
    expect(t.notes.join()).toMatch(/address changes/);
    expect(t.instance.emailFrom).toBe('Openlive <login@new.example.net>');
    const custom = instance({ emailFrom: 'Me <me@mail.example.com>' });
    expect(resolveTarget({ env, domain: 'new.example.net' }, custom, null).instance.emailFrom).toBe(
      'Me <me@mail.example.com>',
    );
  });

  it('never renames the Worker of an existing instance', () => {
    const t = resolveTarget({ env, workersDev: 'openlive-test' }, instance(), null);
    expect(t.errors.join()).toMatch(/instance of Worker openlive.*--env openlive-test/);
  });

  it('a deployed Worker found in the account is the default answer', () => {
    const t = resolveTarget({ env }, null, null, 'live.example.com');
    expect(t).toMatchObject({
      question: 'confirm',
      instance: { route: { kind: 'custom_domain', domain: 'live.example.com' } },
    });
  });

  it('--workers-dev keeps the subdomain already known', () => {
    const file = instance({ route: { kind: 'workers_dev', subdomain: 'acme' } });
    expect(resolveTarget({ env, workersDev: 'openlive' }, file, null).instance.route).toEqual({
      kind: 'workers_dev',
      subdomain: 'acme',
    });
  });
});

describe('logSampling', () => {
  it('is kept by the instance file until --log-sampling changes it', () => {
    const inst = instance({ logSampling: 0.2 });
    expect(parseInstance(serializeInstance(inst), 'f')).toEqual(inst);
    // Files written before the setting have none: the template's rate applies.
    expect(parseInstance(serializeInstance(instance()), 'f').logSampling).toBeUndefined();
    const bad = { ...JSON.parse(serializeInstance(inst)), logSampling: 2 };
    expect(() => parseInstance(JSON.stringify(bad), 'f')).toThrow(/logSampling/);

    const kept = resolveTarget({ env: 'production' }, inst, null);
    expect(kept.instance.logSampling).toBe(0.2);
    expect(kept.write).toBe(false);
    const changed = resolveTarget({ env: 'production', logSampling: 1 }, inst, null);
    expect(changed.instance.logSampling).toBe(1);
    expect(changed.write).toBe(true);
  });
});

describe('patchTarget', () => {
  it('marks the file for writing only when something changed', () => {
    const file = instance({ accountId: 'acc' });
    const t = resolveTarget({ env: 'production' }, file, null);
    expect(patchTarget(t, file, { accountId: 'acc' }).write).toBe(false);
    expect(patchTarget(t, file, { d1: { databaseName: 'openlive', databaseId: 'db' } }).write).toBe(
      true,
    );
  });
});
