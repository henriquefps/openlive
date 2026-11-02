// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ArgsError, emailAddressOf, parseCliArgs } from '../src/args.ts';

describe('parseCliArgs', () => {
  it('defaults', () => {
    expect(parseCliArgs([])).toEqual({
      env: 'production',
      yes: false,
      dryRun: false,
      check: false,
      accountId: undefined,
      domain: undefined,
      workersDev: undefined,
      name: undefined,
      emailFrom: undefined,
      noMetrics: false,
      logSampling: undefined,
      help: false,
    });
    expect(parseCliArgs(['--no-metrics']).noMetrics).toBe(true);
  });

  it('--log-sampling takes a rate from 0 to 1', () => {
    expect(parseCliArgs(['--log-sampling', '0.1']).logSampling).toBe(0.1);
    expect(parseCliArgs(['--log-sampling', '1']).logSampling).toBe(1);
    expect(parseCliArgs(['--log-sampling', '0']).logSampling).toBe(0);
    for (const bad of ['1.5', '-0.1', '10%', 'x', '']) {
      expect(() => parseCliArgs(['--log-sampling', bad]), bad).toThrow(ArgsError);
    }
  });

  it('accepts the separator `pnpm run setup --` passes through', () => {
    expect(parseCliArgs(['--', '--env', 'staging', '--dry-run'])).toMatchObject({
      env: 'staging',
      dryRun: true,
    });
  });

  it('normalizes --domain and --workers-dev', () => {
    expect(parseCliArgs(['--domain', 'Live.Example.com.']).domain).toBe('live.example.com');
    expect(parseCliArgs(['--workers-dev', 'OpenLive-Test']).workersDev).toBe('openlive-test');
  });

  it.each([
    [['--domain', 'a.example.com', '--workers-dev', 'x'], /not both/],
    [['--dry-run', '--check'], /not both/],
    [['--domain', 'https://a.example.com'], /host name only/],
    [['--domain', 'localhost'], /not a host name/],
    [['--domain', 'x.acme.workers.dev'], /--workers-dev/],
    [['--workers-dev', 'bad-'], /Worker name/],
    [['--workers-dev', 'a', '--name', 'b'], /drop --name/],
    [['--name', 'Has Space'], /--name/],
    [['--env', 'Prod'], /--env/],
    [['--email-from', 'not an address'], /--email-from/],
    [['--unknown'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(ArgsError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it('--help skips validation', () => {
    expect(parseCliArgs(['--help', '--env', 'BAD']).help).toBe(true);
  });
});

describe('emailAddressOf', () => {
  it.each([
    ['Openlive <login@live.example.com>', 'login@live.example.com'],
    ['login@live.example.com', 'login@live.example.com'],
    ['Name <bad>', null],
    ['two words@example.com', null],
  ])('%s', (input, out) => {
    expect(emailAddressOf(input)).toBe(out);
  });
});
