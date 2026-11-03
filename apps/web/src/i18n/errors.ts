// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorInput } from '@openlive/client';
import type { ErrorCode } from '@openlive/protocol';
import codes from '@openlive/protocol/schema/codes.json';
import type { TFunction } from 'i18next';
import { formatWait } from './format.ts';
import i18n from './index.ts';

// The API and the Durable Objects return codes, never text; this is the one place
// that turns a code and its parameters into a sentence.

// The code list comes from the schema rather than the package's `ErrorCode` object: importing a
// runtime value from `@openlive/protocol` would bundle its validators (ajv) into the web app.
export const ERROR_CODES = codes.$defs.ErrorCode.enum as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.includes(value as ErrorCode);
}

/** An error body from the API: a code (possibly one this build does not know) plus parameters. */
export type { ErrorInput };

export function translateError(error: ErrorInput, t: TFunction = i18n.t): string {
  const { code, retryAfterMs, preset, ...params } = error;
  if (!isErrorCode(code)) return t('errors.unknown');
  return t(`errors.${code}`, {
    ...params,
    ...(retryAfterMs !== undefined && {
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      retryAfter: formatWait(retryAfterMs, i18n.language),
    }),
    ...(preset !== undefined && { preset: t(`presets.${preset}`) }),
  });
}
