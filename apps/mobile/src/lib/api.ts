// SPDX-License-Identifier: AGPL-3.0-only
import {
  ApiError,
  type ApiClient,
  bearerToken,
  createApiClient,
  exchangeAppToken,
  instanceInfo,
} from '@openlive/client';
import type { AppTokenRequest, AppTokenResponse, InstanceInfo } from '@openlive/protocol';
import { parseInstanceInfo } from './instance.ts';
import { APP_CLIENT, APP_REDIRECT_URI } from './pkce.ts';

// The app's side of the shared client (@openlive/client): the instance's absolute URL as the base,
// the app token as a bearer, and a fetch that gives up after a while and turns "nothing answered"
// into the `network` error code the screens translate.

export { ApiError, type ApiClient };

export type Fetch = typeof globalThis.fetch;

const TIMEOUT_MS = 15_000;

/** The error body to translate: the API's code and parameters, `network` when nothing answered. */
export const NETWORK_ERROR = (): ApiError => new ApiError(0, { code: 'network' });

/**
 * The platform's fetch with a timeout; a failure to connect becomes ApiError(0, network).
 * `onUnauthorized` hears every 401 (the token expired or was revoked).
 */
export function appFetch(onUnauthorized?: () => void, base: Fetch = globalThis.fetch): Fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await base(input, { ...init, signal: controller.signal });
      if (response.status === 401) onUnauthorized?.();
      return response;
    } catch {
      throw NETWORK_ERROR();
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Whether the call failed because the token is gone (expired, revoked): sign in again. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** A client for an instance, signed in with `token()` (null: calls go without). */
export function createAppClient(
  origin: string,
  token: () => string | null | Promise<string | null>,
  fetchFn: Fetch = appFetch(),
): ApiClient {
  return createApiClient({ baseUrl: origin, auth: bearerToken(token), fetch: fetchFn });
}

const anonymous = (origin: string, fetchFn: Fetch) =>
  createAppClient(origin, () => null, appFetch(undefined, fetchFn));

/** GET /.well-known/openlive.json; `invalid_instance` when the answer is not an Openlive one. */
export async function fetchInstanceInfo(
  origin: string,
  fetchFn: Fetch = globalThis.fetch,
): Promise<InstanceInfo> {
  let body: unknown;
  try {
    body = await instanceInfo(anonymous(origin, fetchFn));
  } catch (error) {
    if (error instanceof ApiError && error.status !== 0)
      throw new ApiError(error.status, { code: 'invalid_instance' });
    throw error;
  }
  const info = parseInstanceInfo(body);
  if (!info) throw new ApiError(200, { code: 'invalid_instance' });
  return info;
}

/** POST /api/app/token: the one-time code and its verifier for an app token. */
export function exchangeCode(
  origin: string,
  code: string,
  codeVerifier: string,
  fetchFn: Fetch = globalThis.fetch,
): Promise<AppTokenResponse> {
  const request: AppTokenRequest = {
    code,
    codeVerifier,
    client: APP_CLIENT,
    redirectUri: APP_REDIRECT_URI,
  };
  return exchangeAppToken(anonymous(origin, fetchFn), request);
}
