// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  discordInstructions,
  discordRedirects,
  emailInstructions,
  parseLoginChoice,
  senderDomain,
} from '../src/assistant.ts';

describe('the secrets assistant', () => {
  it('prints the exact Discord redirects for the chosen origin', () => {
    expect(discordRedirects('https://live.example.com')).toEqual([
      'https://live.example.com/api/auth/discord/callback',
      'http://localhost:5179/api/auth/discord/callback',
    ]);
    expect(discordInstructions('https://openlive-test.acme.workers.dev')).toContain(
      'https://openlive-test.acme.workers.dev/api/auth/discord/callback',
    );
  });

  it('accepts Discord only, e-mail only, or both (the default)', () => {
    expect(parseLoginChoice('1')).toEqual(['discord']);
    expect(parseLoginChoice('e-mail')).toEqual(['email']);
    expect(parseLoginChoice('')).toEqual(['discord', 'email']);
    expect(parseLoginChoice('both')).toEqual(['discord', 'email']);
    expect(parseLoginChoice('4')).toBeNull();
  });

  it('names the domain to verify in Resend, or explains workers.dev has none', () => {
    expect(emailInstructions('Openlive <login@live.example.com>')).toMatch(
      /Add Domain → live\.example\.com/,
    );
    expect(emailInstructions(null)).toMatch(/--email-from/);
    expect(senderDomain('Openlive <login@Live.Example.com>')).toBe('live.example.com');
    expect(senderDomain(null)).toBeNull();
  });
});

describe('the guide', () => {
  it('lists a source for every screenshot placeholder', async () => {
    const { SOURCES, screenshotMarkers } = await import('../src/screenshots.ts');
    const { readFileSync } = await import('node:fs');
    const guide = readFileSync(new URL('../../../docs/self-host.md', import.meta.url), 'utf8');
    const markers = screenshotMarkers(guide);
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(SOURCES, m).toHaveProperty(m);
  });
});
