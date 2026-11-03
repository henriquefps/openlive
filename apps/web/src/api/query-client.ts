// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { isWaitError } from '@openlive/client';

/** TanStack Query's default number of retries, kept for every other failure. */
const MAX_RETRIES = 3;

export { isWaitError };

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
