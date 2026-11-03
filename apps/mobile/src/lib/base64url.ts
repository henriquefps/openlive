// SPDX-License-Identifier: AGPL-3.0-only

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding (RFC 4648 section 5), as PKCE wants it (RFC 7636 appendix A). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    if (left > 1) out += ALPHABET[(n >> 6) & 63];
    if (left > 2) out += ALPHABET[n & 63];
  }
  return out;
}

/** UTF-8 bytes of a string (Hermes has TextEncoder, but this keeps the module dependency-free). */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
