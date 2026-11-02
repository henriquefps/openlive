// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { User } from '../src/api/auth.ts';
import { queryClient } from '../src/api/query-client.ts';
import { routeTree } from '../src/router.tsx';

// Renders the whole app (router, guards, layout) at a path, against a fake API.

export type Route = (request: { method: string; body: unknown }) => Response | Promise<Response>;

/** Replaces fetch with a table of `METHOD /path` → response. Returns the recorded calls. */
export function fakeApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input);
      // JSON bodies are parsed; a file (a photo upload) is passed as is.
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path.split('?')[0]}`];
      return route
        ? route({ method, body })
        : Response.json({ code: 'not_found' }, { status: 404 });
    }),
  );
  return calls;
}

export const anonymous = () => Response.json({ code: 'unauthenticated' }, { status: 401 });

export const USER: User = {
  id: 'u_ana',
  displayName: 'Ana',
  avatarUrl: null,
  locale: null,
  isPlatformAdmin: false,
};

export const signedIn =
  (user: Partial<typeof USER> = {}) =>
  () =>
    Response.json({ user: { ...USER, ...user }, memberships: [] });

export const health = () =>
  Response.json({
    ok: true,
    version: '0.1.0',
    commit: 'c820e1f',
    builtAt: '2026-10-28T12:00:00.000Z',
  });

export function renderApp(path: string) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
