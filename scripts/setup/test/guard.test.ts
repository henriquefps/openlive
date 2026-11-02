// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  appOriginProblems,
  devAuthProblems,
  loginProblems,
  realtimePairProblems,
} from '../src/guard.ts';
import { facts } from './fixtures.ts';

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('devAuthProblems', () => {
  it('passes a clean environment', () => {
    expect(devAuthProblems(facts(), ['SESSION_SECRET'], ['SESSION_SECRET'])).toEqual([]);
  });

  it('refuses DEV_AUTH in vars, in the secrets file and on the deployed Worker', () => {
    const f = facts({ vars: { ...facts().vars, DEV_AUTH: '0' } });
    const problems = devAuthProblems(f, ['DEV_AUTH'], ['DEV_AUTH']);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/vars in wrangler.jsonc sets DEV_AUTH/);
    expect(problems.join('\n')).toMatch(/secrets file sets DEV_AUTH/);
    expect(problems.join('\n')).toMatch(/wrangler secret delete DEV_AUTH --env production/);
  });
});

describe('appOriginProblems', () => {
  it('accepts the custom domain origin', () => {
    expect(appOriginProblems(facts())).toEqual([]);
  });

  it.each([
    [{ APP_ORIGIN: 'https://other.example.com' }, /not one of the custom domains/],
    [{ APP_ORIGIN: 'http://openlive.example.com' }, /https/],
    [{ APP_ORIGIN: 'https://openlive.example.com/app' }, /no path/],
    [{ APP_ORIGIN: 'not a url' }, /not a URL/],
    [{}, /no APP_ORIGIN/],
  ])('rejects %o', (vars, message) => {
    expect(appOriginProblems(facts({ vars })).join()).toMatch(message);
  });

  it('accepts workers.dev when there is no custom domain', () => {
    const f = facts({
      customDomains: [],
      workersDev: true,
      vars: { APP_ORIGIN: 'https://openlive.me.workers.dev' },
    });
    expect(appOriginProblems(f)).toEqual([]);
    expect(appOriginProblems({ ...f, vars: { APP_ORIGIN: 'https://x.example.com' } })).toHaveLength(
      1,
    );
  });
});

describe('loginProblems', () => {
  it('needs Discord (both halves) or Resend', () => {
    expect(loginProblems(m({}))).toHaveLength(1);
    expect(loginProblems(m({ DISCORD_CLIENT_ID: '', RESEND_API_KEY: '' }))).toHaveLength(1);
    expect(loginProblems(m({ DISCORD_CLIENT_ID: 'id' }))).toEqual([
      'set both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or neither',
    ]);
    expect(loginProblems(m({ DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 's' }))).toEqual([]);
    expect(loginProblems(m({ RESEND_API_KEY: 're_x' }))).toEqual([]);
  });
});

describe('realtimePairProblems', () => {
  it('needs ids and tokens together', () => {
    expect(realtimePairProblems(m({}))).toEqual([]);
    expect(realtimePairProblems(m({ REALTIME_APP_ID: 'a', REALTIME_APP_TOKEN: 'b' }))).toEqual([]);
    expect(realtimePairProblems(m({ REALTIME_APP_ID: 'a', TURN_KEY_TOKEN: 't' }))).toHaveLength(2);
  });
});
