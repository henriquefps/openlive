// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { isWaitError, queryClient, shouldRetry } from '../src/api/query-client.ts';
import { chatUnreadQuery } from '../src/chat/api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const quota = () => new ApiError(503, { code: 'do_quota_exceeded' });
const rateLimited = () => new ApiError(429, { code: 'rate_limited', retryAfterMs: 5000 });

describe('shouldRetry', () => {
  it('never retries a wait error', () => {
    expect(isWaitError(quota())).toBe(true);
    expect(isWaitError(rateLimited())).toBe(true);
    expect(shouldRetry(0, quota())).toBe(false);
    expect(shouldRetry(0, rateLimited())).toBe(false);
  });

  it('retries other failures up to three times', () => {
    const unavailable = new ApiError(503, { code: 'internal_error' });
    expect(isWaitError(unavailable)).toBe(false);
    expect(shouldRetry(0, unavailable)).toBe(true);
    expect(shouldRetry(2, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(3, unavailable)).toBe(false);
  });

  it('is the shared client default for queries', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(shouldRetry);
  });
});

describe('chat unread on do_quota_exceeded', () => {
  it('asks once, then stops the periodic refresh', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'do_quota_exceeded' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '3600' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetry, retryDelay: 0 } },
    });
    const options = chatUnreadQuery('space_1');
    await expect(client.fetchQuery(options)).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    const query = client.getQueryCache().find({ queryKey: options.queryKey });
    expect(query?.state.error).toBeInstanceOf(ApiError);
    const interval = options.refetchInterval;
    expect(typeof interval === 'function' ? interval(query as never) : interval).toBe(false);
  });
});
