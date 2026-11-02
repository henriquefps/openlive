// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorInput } from '../i18n/errors.ts';

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

function isErrorBody(value: unknown): value is ErrorInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  // Same-origin requests send the session cookie; the browser adds Origin to the ones that
  // change state, which the API checks (CSRF).
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, isErrorBody(body) ? body : { code: 'internal_error' });
  }
  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { headers: { accept: 'application/json' } });
}

/** A state-changing call with an optional JSON body. Resolves to undefined on 204. */
export function apiSend<T = undefined>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Sends a file as the raw request body (its type as Content-Type). */
export function apiUpload<T>(method: 'PUT' | 'POST', path: string, file: Blob): Promise<T> {
  return request<T>(path, {
    method,
    headers: { accept: 'application/json', 'content-type': file.type },
    body: file,
  });
}

/** The error body to translate for anything a query can throw (network failures included). */
export function errorBodyOf(error: unknown): ErrorInput {
  return error instanceof ApiError ? error.body : { code: 'internal_error' };
}
