// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, type ErrorInput } from '@openlive/client';
import type { TFunction } from 'i18next';

/** The error body behind anything a call or a socket can give (an error code alone works too). */
export function errorInput(error: unknown): ErrorInput {
  if (error instanceof ApiError) return error.body;
  if (typeof error === 'string') return { code: error };
  if (typeof error === 'object' && error !== null && typeof (error as ErrorInput).code === 'string')
    return error as ErrorInput;
  return { code: 'internal_error' };
}

/**
 * The message for an API or socket error: `errors.<code>` of the shared locales (the app's own
 * `network` and the like among them), with the error's parameters; the generic one with the code
 * when this build does not know it.
 */
export function errorText(t: TFunction, error: unknown): string {
  const { code, preset, ...params } = errorInput(error);
  return t(`errors.${code}`, {
    ...params,
    ...(preset !== undefined && { preset: t(`presets.${preset}`, { defaultValue: preset }) }),
    defaultValue: t('errors.generic', { code }),
  });
}
