// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64url } from '../src/lib/base64url.ts';
import {
  authorizeUrl,
  codeChallenge,
  createPkce,
  deviceName,
  parseAuthRedirect,
  type PkceCrypto,
} from '../src/lib/pkce.ts';

const nodeCrypto: PkceCrypto = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
};

describe('base64url', () => {
  it('matches Node for every padding case', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});

describe('PKCE', () => {
  it('computes the S256 challenge of RFC 7636 appendix B', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', nodeCrypto)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a 43-character verifier, its challenge and a fresh state', async () => {
    const a = await createPkce(nodeCrypto);
    const b = await createPkce(nodeCrypto);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(await codeChallenge(a.verifier, nodeCrypto));
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });

  it('builds the authorize URL with the exact values the instance checks', async () => {
    const pkce = await createPkce(nodeCrypto);
    const url = new URL(authorizeUrl('https://openlive.example.com', pkce, 'Pixel 8'));
    expect(url.origin + url.pathname).toBe('https://openlive.example.com/app/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: 'openlive-mobile',
      redirect_uri: 'openlive://auth',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      device_name: 'Pixel 8',
    });
  });
});

describe('authorizeUrl with an invite', () => {
  it('adds the invite only when there is one', async () => {
    const pkce = await createPkce(nodeCrypto);
    const token = 'a'.repeat(43);
    const url = new URL(authorizeUrl('https://openlive.example.com', pkce, 'Pixel 8', token));
    expect(url.searchParams.get('invite')).toBe(token);
    expect(url.searchParams.get('redirect_uri')).toBe('openlive://auth');
    const plain = new URL(authorizeUrl('https://openlive.example.com', pkce, 'Pixel 8'));
    expect(plain.searchParams.has('invite')).toBe(false);
  });
});

describe('parseAuthRedirect', () => {
  const state = 'abcDEF123_-xyz';

  it('takes the code when the state is ours', () => {
    expect(parseAuthRedirect(`openlive://auth?code=c0de&state=${state}`, state)).toEqual({
      ok: true,
      code: 'c0de',
    });
    expect(parseAuthRedirect(`openlive://auth/?code=c0de&state=${state}`, state)).toEqual({
      ok: true,
      code: 'c0de',
    });
  });

  it('refuses a code that comes with another state, or none', () => {
    expect(parseAuthRedirect('openlive://auth?code=c0de&state=other', state)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
    expect(parseAuthRedirect('openlive://auth?code=c0de', state)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
  });

  it('reads a refusal', () => {
    expect(parseAuthRedirect(`openlive://auth?error=access_denied&state=${state}`, state)).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('rejects anything that is not openlive://auth with a code', () => {
    for (const url of [
      `openlive://authx?code=c&state=${state}`,
      `openlive://join?code=c&state=${state}`,
      `https://evil.example.com/auth?code=c&state=${state}`,
      `openlive://auth?state=${state}`,
    ]) {
      expect(parseAuthRedirect(url, state).ok).toBe(false);
    }
  });
});

describe('deviceName', () => {
  it('uses the model, or the fallback, within 64 characters', () => {
    expect(deviceName('  Pixel 8 Pro ', 'Android')).toBe('Pixel 8 Pro');
    expect(deviceName(null, 'Android')).toBe('Android');
    expect(deviceName('', 'Android')).toBe('Android');
    expect(deviceName('x'.repeat(100), 'Android')).toHaveLength(64);
  });
});
