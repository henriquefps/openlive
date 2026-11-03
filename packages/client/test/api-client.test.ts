// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  bearerToken,
  cookieSession,
  createApiClient,
  errorBodyOf,
  getMe,
  listRooms,
} from '../src/index.ts';

type Fetch = typeof globalThis.fetch;

function fakeFetch(response: () => Response = () => Response.json({ rooms: [] })) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response());
}

const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;

describe('API client, browser cookie session', () => {
  it('sends same-origin requests exactly as the web always has: relative path, no credentials option', async () => {
    const fetch = fakeFetch();
    const api = createApiClient({ auth: cookieSession(), fetch: fetch as Fetch });
    await listRooms(api, 'sp 1');
    expect(fetch).toHaveBeenCalledWith('/api/spaces/sp%201/rooms', {
      headers: { accept: 'application/json' },
    });
    await api.send('PATCH', '/api/rooms/rm_1', { name: 'x' });
    expect(fetch.mock.calls[1]).toEqual([
      '/api/rooms/rm_1',
      {
        method: 'PATCH',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{"name":"x"}',
      },
    ]);
  });

  it('is the default, and looks the global fetch up on every call', async () => {
    const fetch = fakeFetch();
    vi.stubGlobal('fetch', fetch);
    try {
      await listRooms(createApiClient(), 'sp_1');
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('API client, app token', () => {
  it('prefixes the instance URL and sends the token as a bearer, never a cookie', async () => {
    const fetch = fakeFetch();
    const api = createApiClient({
      baseUrl: 'https://openlive.example/',
      auth: bearerToken(() => 'ola_token'),
      fetch: fetch as Fetch,
    });
    await api.send('POST', '/api/spaces', { name: 'S' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://openlive.example/api/spaces');
    expect(init?.credentials).toBe('omit');
    expect(headersOf(init)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ola_token',
    });
  });

  it('reads the token on every request, asynchronously if need be, and goes without when there is none', async () => {
    const fetch = fakeFetch();
    let token: string | null = null;
    const api = createApiClient({
      baseUrl: 'https://openlive.example',
      auth: bearerToken(async () => token),
      fetch: fetch as Fetch,
    });
    await api.get('/api/me');
    token = 'ola_later';
    await api.get('/api/me');
    expect(headersOf(fetch.mock.calls[0]?.[1]).authorization).toBeUndefined();
    expect(headersOf(fetch.mock.calls[1]?.[1]).authorization).toBe('Bearer ola_later');
  });
});

describe('API errors', () => {
  it('carry the status and the body the API returned', async () => {
    const fetch = fakeFetch(() => Response.json({ code: 'forbidden' }, { status: 403 }));
    const api = createApiClient({ fetch: fetch as Fetch });
    const error = await api.get('/api/spaces').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(errorBodyOf(error)).toEqual({ code: 'forbidden' });
  });

  it('are internal_error when the body is not an error, or the call never got an answer', async () => {
    const api = createApiClient({
      fetch: fakeFetch(() => new Response('oops', { status: 502 })) as Fetch,
    });
    expect(errorBodyOf(await api.get('/x').catch((e: unknown) => e))).toEqual({
      code: 'internal_error',
    });
    expect(errorBodyOf(new TypeError('Failed to fetch'))).toEqual({ code: 'internal_error' });
  });

  it('getMe answers null for 401 (nobody signed in) and throws anything else', async () => {
    const signedOut = createApiClient({
      fetch: fakeFetch(() => Response.json({ code: 'unauthenticated' }, { status: 401 })) as Fetch,
    });
    expect(await getMe(signedOut)).toBeNull();
    const broken = createApiClient({
      fetch: fakeFetch(() => Response.json({ code: 'internal_error' }, { status: 500 })) as Fetch,
    });
    await expect(getMe(broken)).rejects.toBeInstanceOf(ApiError);
  });
});
