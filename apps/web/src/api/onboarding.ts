// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from '@tanstack/react-query';
import { apiGet, apiSend } from './client.ts';
import { queryClient } from './query-client.ts';

// The admin onboarding wizard (apps/api/src/api/onboarding.ts): its checks and its
// progress. The tutorial's state lives in tutorial/state.ts.

export type CheckId = 'discord' | 'email' | 'sfu' | 'turn' | 'd1' | 'r2';
export const CHECK_IDS: readonly CheckId[] = ['discord', 'email', 'sfu', 'turn', 'd1', 'r2'];

export interface CheckResult {
  id: CheckId;
  status: 'ok' | 'missing' | 'error';
  code:
    | 'configured'
    | 'secret_missing'
    | 'auth_failed'
    | 'unreachable'
    | 'unexpected_response'
    | 'binding_failed';
  /** Names of the secrets that are not set. */
  missing?: string[];
}

export const checksQuery = queryOptions({
  queryKey: ['admin', 'checks'],
  queryFn: async () => (await apiGet<{ checks: CheckResult[] }>('/api/admin/checks')).checks,
  staleTime: 0,
});

export const ONBOARDING_STEPS = 7;

export interface Onboarding {
  /** The step to resume at, 1–7. */
  step: number;
  completedAt: number | null;
  skippedAt: number | null;
}

export type OnboardingState = 'in_progress' | 'skipped' | 'completed';

export const onboardingQuery = queryOptions({
  queryKey: ['admin', 'onboarding'],
  queryFn: async () =>
    (await apiGet<{ onboarding: Onboarding }>('/api/admin/onboarding')).onboarding,
});

export async function saveOnboarding(step: number, state: OnboardingState): Promise<Onboarding> {
  const saved = (
    await apiSend<{ onboarding: Onboarding }>('PUT', '/api/admin/onboarding', { step, state })
  ).onboarding;
  queryClient.setQueryData(onboardingQuery.queryKey, saved);
  return saved;
}
