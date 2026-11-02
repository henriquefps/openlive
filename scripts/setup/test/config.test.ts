// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  analyticsEngineNotEnabled,
  analyticsEngineUrl,
  ConfigError,
  GENERATED_HEADER,
  PLACEHOLDER_ID,
  readEnvFacts,
  renderInstanceConfig,
} from '../src/config.ts';
import { instance, realConfig } from './fixtures.ts';

interface RenderedEnv {
  name: string;
  account_id?: string;
  routes?: { pattern: string; custom_domain: boolean }[];
  workers_dev: boolean;
  vars: Record<string, string>;
  d1_databases: { database_name: string; database_id: string }[];
  r2_buckets: { bucket_name: string }[];
  analytics_engine_datasets?: { binding: string; dataset: string }[];
  observability?: { enabled: boolean; head_sampling_rate?: number };
  durable_objects: unknown;
  assets: unknown;
}
const envOf = (text: string, env: string) =>
  (
    parse(text, [], { allowTrailingComma: true }) as {
      d1_databases: { database_id: string }[];
      env: Record<string, RenderedEnv>;
    }
  ).env[env] as RenderedEnv;

describe('the committed wrangler.jsonc', () => {
  it('holds no instance: a template with placeholders, no route', () => {
    const f = readEnvFacts(realConfig, 'production');
    expect(f).toMatchObject({
      workerName: 'openlive',
      d1: { binding: 'DB', databaseName: 'openlive', databaseId: PLACEHOLDER_ID },
      r2: { binding: 'THUMBNAILS', bucketName: 'openlive-thumbnails' },
      customDomains: [],
      workersDev: false,
      hasAssets: true,
      accountId: null,
    });
    expect(f.vars['APP_ORIGIN']).toBe('https://openlive.example.com');
    expect(f.vars).not.toHaveProperty('DEV_AUTH');
  });

  it('names no real instance or account anywhere in the versioned setup inputs', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const file of ['apps/api/wrangler.jsonc', 'apps/api/.secrets.example']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).not.toMatch(/hfps\.dev/);
      expect(text, file).not.toMatch(/"account_id"/);
      expect(text, file).not.toMatch(/"database_id": "(?!0{8}-0{4}-0{4}-0{4}-0{12})/);
    }
  });
});

describe('readEnvFacts', () => {
  it('defaults the name and workers_dev like wrangler', () => {
    const f = readEnvFacts('{ "name": "w", "env": { "staging": {} } }', 'staging');
    expect(f).toMatchObject({ workerName: 'w-staging', workersDev: true, d1: null, r2: null });
  });

  it('fails on an unknown environment, listing the known ones', () => {
    expect(() => readEnvFacts(realConfig, 'nope')).toThrow(
      /no env.nope \(environments: production\)/,
    );
  });

  it('fails on invalid JSONC', () => {
    expect(() => readEnvFacts('{ "env": ', 'x')).toThrow(ConfigError);
  });
});

describe('renderInstanceConfig', () => {
  const dbId = '11111111-2222-3333-4444-555555555555';

  it('writes the build as APP_COMMIT and APP_BUILT_AT, and leaves them out without one', () => {
    const ids = { accountId: 'acc123', databaseId: dbId };
    const build = { commit: 'c820e1f-dirty', builtAt: '2026-10-28T12:00:00.000Z' };
    const withBuild = envOf(
      renderInstanceConfig(realConfig, 'production', instance(), ids, { build }),
      'production',
    );
    expect(withBuild.vars).toMatchObject({
      APP_COMMIT: 'c820e1f-dirty',
      APP_BUILT_AT: '2026-10-28T12:00:00.000Z',
    });
    const without = envOf(
      renderInstanceConfig(realConfig, 'production', instance(), ids),
      'production',
    );
    expect(without.vars).not.toHaveProperty('APP_COMMIT');
    expect(without.vars).not.toHaveProperty('APP_BUILT_AT');
  });

  it('a custom domain: route, origin, sender, names and ids of this instance only', () => {
    const out = renderInstanceConfig(realConfig, 'production', instance(), {
      accountId: 'acc123',
      databaseId: dbId,
    });
    expect(out.startsWith(GENERATED_HEADER)).toBe(true);
    const env = envOf(out, 'production');
    expect(env).toMatchObject({
      name: 'openlive',
      account_id: 'acc123',
      routes: [{ pattern: 'openlive.example.com', custom_domain: true }],
      workers_dev: false,
      vars: {
        APP_ORIGIN: 'https://openlive.example.com',
        EMAIL_FROM: 'Openlive <login@openlive.example.com>',
      },
    });
    expect(env.d1_databases[0]?.database_id).toBe(dbId);
    // The local-dev placeholder at the top level is untouched.
    const top = parse(out, [], { allowTrailingComma: true }) as {
      d1_databases: { database_id: string }[];
    };
    expect(top.d1_databases[0]?.database_id).toBe(PLACEHOLDER_ID);
    // Top-level comments survive, so the generated file still explains itself.
    expect(out).toContain('Local dev and tests work with it as is');
    const f = readEnvFacts(out, 'production');
    expect(f).toMatchObject({ customDomains: ['openlive.example.com'], accountId: 'acc123' });
  });

  it('keeps every template binding, including ones added later (Analytics Engine)', () => {
    const out = renderInstanceConfig(realConfig, 'production', instance(), {
      accountId: 'a',
      databaseId: dbId,
    });
    const env = envOf(out, 'production');
    const template = envOf(realConfig, 'production');
    expect(env.durable_objects).toEqual(template.durable_objects);
    expect(env.assets).toEqual(template.assets);
    expect(env.analytics_engine_datasets).toEqual(template.analytics_engine_datasets);
  });

  it("Workers Logs: the template's sampling, or the instance's, passed to the Worker too", () => {
    const ids = { accountId: 'a', databaseId: dbId };
    const byDefault = envOf(
      renderInstanceConfig(realConfig, 'production', instance(), ids),
      'production',
    );
    expect(byDefault.observability).toEqual({ enabled: true, head_sampling_rate: 0.1 });
    expect(byDefault.vars['LOG_SAMPLING_RATE']).toBe('0.1');
    const chosen = envOf(
      renderInstanceConfig(realConfig, 'production', instance({ logSampling: 0.5 }), ids),
      'production',
    );
    expect(chosen.observability).toEqual({ enabled: true, head_sampling_rate: 0.5 });
    expect(chosen.vars['LOG_SAMPLING_RATE']).toBe('0.5');
  });

  it('workers.dev: no route, workers_dev on, the workers.dev origin, new resource names', () => {
    const inst = instance({
      workerName: 'openlive-test',
      route: { kind: 'workers_dev', subdomain: 'acme' },
      emailFrom: null,
      d1: { databaseName: 'openlive-test', databaseId: null },
      r2: { bucketName: 'openlive-test-thumbnails', created: false },
    });
    const out = renderInstanceConfig(realConfig, 'openlive-test', inst, {
      accountId: null,
      databaseId: null,
    });
    const env = envOf(out, 'openlive-test');
    expect(env.routes).toBeUndefined();
    expect(env.account_id).toBeUndefined();
    expect(env).toMatchObject({ name: 'openlive-test', workers_dev: true });
    expect(env.vars).toEqual({
      APP_ORIGIN: 'https://openlive-test.acme.workers.dev',
      LOG_SAMPLING_RATE: '0.1',
    });
    expect(env.d1_databases[0]).toMatchObject({
      database_name: 'openlive-test',
      database_id: PLACEHOLDER_ID,
    });
    expect(env.r2_buckets[0]?.bucket_name).toBe('openlive-test-thumbnails');
    // Only the instance's environment is in the generated file.
    expect(envOf(out, 'production')).toBeUndefined();
    const f = readEnvFacts(out, 'openlive-test');
    expect(f).toMatchObject({ workersDev: true, customDomains: [] });
  });
});

describe('Analytics Engine fallback', () => {
  const ids = { accountId: 'acc', databaseId: '11111111-2222-3333-4444-555555555555' };

  it('metrics: false drops only the Analytics Engine binding', () => {
    const withAe = envOf(
      renderInstanceConfig(realConfig, 'production', instance(), ids),
      'production',
    );
    const without = envOf(
      renderInstanceConfig(realConfig, 'production', instance(), ids, { metrics: false }),
      'production',
    );
    expect(withAe.analytics_engine_datasets).toEqual([
      { binding: 'METRICS', dataset: 'openlive_metrics' },
    ]);
    expect(without.analytics_engine_datasets).toBeUndefined();
    expect(without).toEqual({ ...withAe, analytics_engine_datasets: undefined });
  });

  it('recognizes wrangler error 10089 and links the dashboard page', () => {
    expect(
      analyticsEngineNotEnabled(
        '✘ [ERROR] A request to the Cloudflare API failed. You need to enable Analytics Engine. [code: 10089]',
      ),
    ).toBe(true);
    expect(analyticsEngineNotEnabled('✘ [ERROR] Authentication error [code: 10000]')).toBe(false);
    expect(analyticsEngineUrl('acc')).toBe(
      'https://dash.cloudflare.com/acc/workers/analytics-engine',
    );
  });
});
