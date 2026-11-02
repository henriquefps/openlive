// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorBodyOf } from '../src/api/client.ts';
import {
  acceptInvite,
  archiveRoom,
  changeRole,
  createInvite,
  spacesQuery,
  updateSpace,
} from '../src/api/spaces.ts';
import i18n from '../src/i18n/index.ts';
import { translateError } from '../src/i18n/errors.ts';

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const listSpaces = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(spacesQuery);

function stubFetch(response: () => Response | Promise<Response>) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
    response(),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('API client errors', () => {
  it('carries the status, code and parameters, which translateError turns into a sentence', async () => {
    stubFetch(() =>
      Response.json(
        { code: 'setting_above_ceiling', path: '/settings/maxStreams', limit: 4 },
        {
          status: 400,
        },
      ),
    );
    const error = await rejection(updateSpace('sp_1', { settings: { maxStreams: 9 } }));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(errorBodyOf(error)).toEqual({
      code: 'setting_above_ceiling',
      path: '/settings/maxStreams',
      limit: 4,
    });
    expect(translateError(errorBodyOf(error))).toBe('This value can be at most 4.');
    await i18n.changeLanguage('pt-BR');
    expect(translateError(errorBodyOf(error))).toBe('Este valor pode ser no máximo 4.');
  });

  it('maps a body without a code, and network failures, to internal_error', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const badGateway = await rejection(listSpaces());
    expect((badGateway as ApiError).status).toBe(502);
    expect(errorBodyOf(badGateway)).toEqual({ code: 'internal_error' });

    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const offline = await rejection(acceptInvite('t'.repeat(43)));
    expect(offline).not.toBeInstanceOf(ApiError);
    expect(translateError(errorBodyOf(offline))).toBe(
      'The server had a problem. Please try again.',
    );
  });

  it('keeps unknown codes from newer servers as a generic message', async () => {
    stubFetch(() => Response.json({ code: 'something_new' }, { status: 409 }));
    const error = await rejection(changeRole('sp_1', 'u_1', 'member'));
    expect(errorBodyOf(error)).toEqual({ code: 'something_new' });
    expect(translateError(errorBodyOf(error))).toBe('Something went wrong. Please try again.');
  });
});

describe('API client requests', () => {
  it('sends JSON with the method and an encoded path', async () => {
    const fetch = stubFetch(() =>
      Response.json({ invite: { id: 'in_1' }, token: 'x'.repeat(43) }, { status: 201 }),
    );
    const result = await createInvite('sp 1', { role: 'guest', maxUses: 3 });
    expect(result.token).toHaveLength(43);
    const [path, init] = fetch.mock.calls[0] ?? [];
    expect(path).toBe('/api/spaces/sp%201/invites');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'guest', maxUses: 3 }),
    });
  });

  it('resolves a 204 to undefined and unwraps list bodies', async () => {
    stubFetch(() => Response.json({ spaces: [{ id: 'sp_1' }] }));
    expect(await listSpaces()).toEqual([{ id: 'sp_1' }]);
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(archiveRoom('rm_1')).resolves.toBeUndefined();
  });
});
