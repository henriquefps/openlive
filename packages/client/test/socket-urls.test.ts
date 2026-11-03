// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  CLOSE,
  createApiClient,
  QUOTA_CLOSE,
  SocketDialError,
  socketPaths,
  socketUrl,
  ticketSocketUrl,
} from '../src/index.ts';

describe('socketUrl', () => {
  it('turns an instance or page origin into its socket URL', () => {
    expect(socketUrl('https://openlive.example', '/ws/hub')).toBe('wss://openlive.example/ws/hub');
    expect(socketUrl('http://localhost:5179/rooms/x', '/ws/hub')).toBe(
      'ws://localhost:5179/ws/hub',
    );
    expect(socketUrl('wss://a.example', socketPaths.room('rm/1'))).toBe(
      'wss://a.example/ws/rooms/rm%2F1',
    );
    expect(socketPaths.space('sp_1')).toBe('/ws/spaces/sp_1');
  });

  it('refuses a relative URL: the app must know its instance', () => {
    expect(() => socketUrl('', '/ws/hub')).toThrow();
  });
});

function ticketApi(response: () => Response) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    response(),
  );
  const api = createApiClient({
    baseUrl: 'https://openlive.example',
    auth: bearerToken(() => 'ola_token'),
    fetch: fetch as typeof globalThis.fetch,
  });
  return { api, fetch };
}

describe('ticketSocketUrl', () => {
  it('fetches a fresh single-use ticket with the app token for every connect', async () => {
    let n = 0;
    const { api, fetch } = ticketApi(() => Response.json({ ticket: `olt_${++n}`, expiresAt: 0 }));
    const url = ticketSocketUrl(api, socketPaths.room('rm_1'));
    expect(await url()).toBe('wss://openlive.example/ws/rooms/rm_1?ticket=olt_1');
    expect(await url()).toBe('wss://openlive.example/ws/rooms/rm_1?ticket=olt_2');
    const [path, init] = fetch.mock.calls[0] ?? [];
    expect(path).toBe('https://openlive.example/api/app/ws-ticket');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ola_token');
  });

  it.each([
    [401, 'unauthenticated', CLOSE.Unauthenticated],
    [503, 'do_quota_exceeded', QUOTA_CLOSE],
    [429, 'rate_limited', 1006],
    [500, 'internal_error', 1006],
  ])('a %i %s becomes a dial error with close code %i', async (status, code, closeCode) => {
    const { api } = ticketApi(() => Response.json({ code }, { status }));
    const url = ticketSocketUrl(api, socketPaths.hub());
    const error = await url().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocketDialError);
    expect((error as SocketDialError).code).toBe(closeCode);
  });

  it('a network failure is a 1006 too (reconnect with backoff)', async () => {
    const { api } = ticketApi(() => {
      throw new TypeError('Network request failed');
    });
    const url = ticketSocketUrl(api, socketPaths.hub());
    expect(((await url().catch((e: unknown) => e)) as SocketDialError).code).toBe(1006);
  });
});
