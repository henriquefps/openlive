// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorPayload } from '@openlive/protocol';

// The REST API client shared by the web and the mobile app. It knows
// two ways to be signed in: the browser's session cookie (the web, same origin) and an app token
// sent as a bearer (the mobile app, docs/PROTOCOL.md 11.6). Nothing here touches the DOM: fetch
// is the platform's (browser, React Native, Node) or one passed in.

/** An error body from the API: a code (possibly one this build does not know) plus parameters. */
export type ErrorInput = Omit<ErrorPayload, 'code'> & { code: string };

/** A failed API call, carrying the error code (and parameters) the API returned. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorInput;

  constructor(status: number, body: ErrorInput) {
    super(`API error ${status}: ${body.code}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A failure that asks to wait, which a retry seconds later only repeats: 429 (rate limited) and
 * 503 do_quota_exceeded (a Durable Objects free-tier limit is used up; Cloudflare documents a
 * reset at 00:00 UTC, but it can take up to 24 hours).
 */
export function isWaitError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 429 || (error.status === 503 && error.body.code === 'do_quota_exceeded'))
  );
}

/** The error body to translate for anything a call can throw (network failures included). */
export function errorBodyOf(error: unknown): ErrorInput {
  return error instanceof ApiError ? error.body : { code: 'internal_error' };
}

/**
 * How requests are signed in.
 * - `cookie`: the browser's session cookie, same origin. The browser adds Origin to the requests
 *   that change state, which the API checks (CSRF). Requests go out exactly as before.
 * - `bearer`: an app token (`ola_…`) as `Authorization: Bearer`, never with a cookie. `token`
 *   is read on every request (null: none yet, the request goes without).
 */
export type ApiAuth =
  { kind: 'cookie' } | { kind: 'bearer'; token: () => string | null | Promise<string | null> };

export const cookieSession = (): ApiAuth => ({ kind: 'cookie' });

export const bearerToken = (token: () => string | null | Promise<string | null>): ApiAuth => ({
  kind: 'bearer',
  token,
});

export interface ApiClientOptions {
  /**
   * Prefixed to every path: '' for the web (same origin, paths stay relative), the instance URL
   * (`https://openlive.example`) for the app. A trailing slash is dropped.
   */
  baseUrl?: string;
  auth?: ApiAuth;
  /** The platform's fetch by default, looked up on every call (tests stub the global). */
  fetch?: typeof globalThis.fetch;
}

export type SendMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiClient {
  /** The instance URL ('' on the web): where the sockets are too (socket/urls.ts). */
  readonly baseUrl: string;
  readonly auth: ApiAuth;
  get<T>(path: string): Promise<T>;
  /** A state-changing call with an optional JSON body. Resolves to undefined on 204. */
  send<T = undefined>(method: SendMethod, path: string, body?: unknown): Promise<T>;
  /** Sends a file as the raw request body (its type as Content-Type). */
  upload<T>(method: 'PUT' | 'POST', path: string, file: Blob): Promise<T>;
}

function isErrorBody(value: unknown): value is ErrorInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const auth = options.auth ?? cookieSession();

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    let sent = init;
    if (auth.kind === 'bearer') {
      const token = await auth.token();
      sent = {
        ...init,
        // A bearer is never sent along with a cookie (PROTOCOL 11.6).
        credentials: 'omit',
        headers: {
          ...(init.headers as Record<string, string>),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
    }
    const fetch = options.fetch ?? globalThis.fetch;
    const response = await fetch(`${baseUrl}${path}`, sent);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new ApiError(response.status, isErrorBody(body) ? body : { code: 'internal_error' });
    }
    return body as T;
  }

  return {
    baseUrl,
    auth,
    get: <T>(path: string) => request<T>(path, { headers: { accept: 'application/json' } }),
    send: <T = undefined>(method: SendMethod, path: string, body?: unknown) =>
      request<T>(path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    upload: <T>(method: 'PUT' | 'POST', path: string, file: Blob) =>
      request<T>(path, {
        method,
        headers: { accept: 'application/json', 'content-type': file.type },
        body: file,
      }),
  };
}
