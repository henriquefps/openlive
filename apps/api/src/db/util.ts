// SPDX-License-Identifier: AGPL-3.0-only
// Helpers shared by the data-access modules.

/** A new opaque id: `<prefix>_<32 hex chars>`, valid for the protocol's Id pattern. */
export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

export function isUniqueViolation(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err).includes('UNIQUE constraint failed');
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Tokens are stored only as their SHA-256. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** 32 random bytes, base64url without padding (43 characters). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** A *_json column as an object; anything else (bad JSON, arrays) reads as empty. */
export function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
