// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import {
  buildUsageQuery,
  fetchRealtimeUsage,
  GRAPHQL_ENDPOINT,
  parseUsageResponse,
  RealtimeUsageError,
} from '../src/usage/realtime-usage';
import empty from './fixtures/realtime-usage-empty.json';
import graphqlError from './fixtures/realtime-usage-error.json';
import twoDays from './fixtures/realtime-usage.json';

const params = {
  accountId: 'acct-1',
  appId: 'app-openlive-dev',
  start: new Date('2026-10-26T00:00:00Z'),
  end: new Date('2026-10-27T15:00:00Z'),
};

describe('buildUsageQuery', () => {
  it('asks both datasets per day for one account and app, like usage.sh', () => {
    const { query, variables } = buildUsageQuery(params);
    expect(query).toContain('accounts(filter: { accountTag: $account })');
    expect(query).toMatch(/callsUsageAdaptiveGroups\(.*appId_in: \$appIds/);
    expect(query).toContain('callsTurnUsageAdaptiveGroups(');
    expect(query).toContain('dimensions { appId date }');
    expect(query).toContain('dimensions { keyId date }');
    expect(query).not.toContain('keyId_in');
    expect(variables).toEqual({
      account: 'acct-1',
      appIds: ['app-openlive-dev'],
      start: '2026-10-26T00:00:00.000Z',
      end: '2026-10-27T15:00:00.000Z',
    });
  });

  it('filters TURN by key when given', () => {
    const { query, variables } = buildUsageQuery({ ...params, turnKeyIds: ['turn-key-1'] });
    expect(query).toContain('$turnKeyIds: [string!]');
    expect(query).toContain('keyId_in: $turnKeyIds');
    expect(variables.turnKeyIds).toEqual(['turn-key-1']);
  });

  it('rejects empty, reversed and over-32-day windows', () => {
    const at = (d: string) => new Date(d);
    expect(() => buildUsageQuery({ ...params, end: params.start })).toThrow(RangeError);
    expect(() =>
      buildUsageQuery({ ...params, start: at('2026-10-27'), end: at('2026-10-26') }),
    ).toThrow(RangeError);
    expect(() =>
      buildUsageQuery({ ...params, start: at('2026-09-01'), end: at('2026-10-04') }),
    ).toThrow(RangeError);
    expect(() =>
      buildUsageQuery({ ...params, start: at('2026-09-01'), end: at('2026-10-03') }),
    ).not.toThrow();
  });
});

describe('parseUsageResponse', () => {
  it('totals per app and per day', () => {
    const u = parseUsageResponse(twoDays);
    expect(u.sfuEgressBytes).toBe(15_900_000_000);
    expect(u.turnEgressBytes).toBe(600_000_000);
    expect(u.totalEgressBytes).toBe(16_500_000_000);
    expect(u.byApp).toEqual({ 'app-openlive-dev': 15_900_000_000 });
    expect(u.byDay).toEqual({ '2026-10-26': 13_100_000_000, '2026-10-27': 3_400_000_000 });
    expect(u.rows).toContainEqual({
      day: '2026-10-26',
      service: 'turn',
      resourceId: 'turn-key-1',
      egressBytes: 600_000_000,
    });
  });

  it('handles an account with no traffic', () => {
    expect(parseUsageResponse(empty)).toMatchObject({ rows: [], totalEgressBytes: 0, byDay: {} });
  });

  it('throws GraphQL errors as graphql_error', () => {
    expect(() => parseUsageResponse(graphqlError)).toThrow(
      expect.objectContaining({
        code: 'graphql_error',
        message: 'not authorized for that account',
      }),
    );
  });

  it('throws on a response without an account', () => {
    expect(() => parseUsageResponse({ data: { viewer: { accounts: [] } } })).toThrow(
      RealtimeUsageError,
    );
  });
});

describe('fetchRealtimeUsage', () => {
  it('posts the query with the bearer token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(twoDays));
    const u = await fetchRealtimeUsage('test-token', params, fetchFn);
    expect(u.totalEgressBytes).toBe(16_500_000_000);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(GRAPHQL_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    expect(JSON.parse(init?.body as string)).toEqual(buildUsageQuery(params));
  });

  it('reports HTTP errors without the token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));
    const err = await fetchRealtimeUsage('secret-token', params, fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeUsageError);
    expect(err).toMatchObject({ code: 'http_error' });
    expect(String((err as Error).message)).not.toContain('secret-token');
  });
});
