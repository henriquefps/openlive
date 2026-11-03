// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, listSpaces, ticketSocketUrl } from '@openlive/client';
import { describe, expect, it } from 'vitest';
import { appFetch, createAppClient, isUnauthenticated } from '../src/lib/api.ts';
import { errorText } from '../src/i18n/errors.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the app client', () => {
  it('sends the bearer token to the instance URL, without a cookie', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const api = createAppClient(
      'https://openlive.example.com',
      () => 'ola_abc',
      appFetch(undefined, async (url, init) => {
        seen.push({ url: String(url), init });
        return json(200, { spaces: [] });
      }),
    );
    expect(await listSpaces(api)).toEqual([]);
    expect(seen[0]?.url).toBe('https://openlive.example.com/api/spaces');
    expect(seen[0]?.init?.credentials).toBe('omit');
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer ola_abc');
  });

  it('turns a failed connection into the network error', async () => {
    const api = createAppClient(
      'https://x.example.com',
      () => null,
      appFetch(undefined, async () => {
        throw new TypeError('Network request failed');
      }),
    );
    await expect(listSpaces(api)).rejects.toMatchObject({ status: 0, body: { code: 'network' } });
  });

  it('tells the 401 hook and keeps the error', async () => {
    let heard = 0;
    const api = createAppClient(
      'https://x.example.com',
      () => 'ola_x',
      appFetch(
        () => heard++,
        async () => json(401, { code: 'unauthenticated' }),
      ),
    );
    const error = await listSpaces(api).catch((e: unknown) => e);
    expect(heard).toBe(1);
    expect(isUnauthenticated(error)).toBe(true);
  });

  it('asks for a ticket before building a room socket URL', async () => {
    const calls: string[] = [];
    const api = createAppClient(
      'https://openlive.example.com',
      () => 'ola_abc',
      appFetch(undefined, async (url, init) => {
        calls.push(`${init?.method} ${String(url)}`);
        return json(200, { ticket: 'tkt 1', expiresAt: 1 });
      }),
    );
    const url = await ticketSocketUrl(api, '/ws/rooms/r1')();
    expect(calls).toEqual(['POST https://openlive.example.com/api/app/ws-ticket']);
    expect(url).toBe('wss://openlive.example.com/ws/rooms/r1?ticket=tkt%201');
  });
});

describe('errorText', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    `${key}|${JSON.stringify(options ?? {})}`) as never;

  it('looks up errors.<code> with the error parameters', () => {
    expect(errorText(t, new ApiError(429, { code: 'rate_limited', retryAfterMs: 2000 }))).toContain(
      'errors.rate_limited|',
    );
    expect(errorText(t, 'network')).toContain('errors.network|');
    expect(errorText(t, new Error('boom'))).toContain('errors.internal_error|');
  });
});
