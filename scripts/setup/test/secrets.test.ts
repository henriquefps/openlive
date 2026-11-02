// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { generateInstallCode, generateSessionSecret } from '../src/secrets.ts';

describe('generated secrets', () => {
  it('SESSION_SECRET is 32 bytes of base64url', () => {
    const s = generateSessionSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionSecret()).not.toBe(s);
  });

  it('INSTALL_CODE is three groups of four unambiguous characters', () => {
    expect(generateInstallCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    const fixed = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i * 8 + 31));
    expect(generateInstallCode(fixed)).toBe(generateInstallCode(fixed));
  });
});
