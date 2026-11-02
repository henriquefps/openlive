// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client.ts';

/** TanStack Query's default number of retries, kept for every other failure. */
const MAX_RETRIES = 3;

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

/** The shared retry rule for queries: never after a wait error, otherwise the default three. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return !isWaitError(error) && failureCount < MAX_RETRIES;
}

/**
 * The app's one QueryClient, shared by React Query and the router's route guards. Mutations keep
 * TanStack's default of no retries.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetry } },
});
