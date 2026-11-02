// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm --filter @openlive/setup screenshots`: the screenshots of docs/self-host.md.
//
// STUB. The guide marks each image with `<!-- screenshot: <name> -->`. This lists the markers and
// where each image comes from; capturing is not implemented yet. The plan: drive Orca's browser (or Playwright) through each page with a throwaway account, crop to
// the element below, write docs/img/self-host/<name>.png, and replace the marker with the image.
// Never hand-edited or made-up images.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Where each screenshot is taken. A marker missing here is reported. */
export const SOURCES: Record<string, string> = {
  'discord-oauth-redirects':
    'discord.com/developers/applications → the app → OAuth2 → Redirects (with the example URL)',
  'resend-api-key-sending-access': 'resend.com → API Keys → Create API Key, "Sending access"',
  'resend-domain-verified': 'resend.com → Domains → the domain, status Verified',
  'cloudflare-analytics-token':
    'dash.cloudflare.com → My Profile → API Tokens → Create Custom Token (Account Analytics: Read)',
  'admin-onboarding-checks': 'a local instance (`pnpm --filter @openlive/api dev`) → /admin/setup',
};

export function screenshotMarkers(markdown: string): string[] {
  return [...markdown.matchAll(/<!-- screenshot: ([a-z0-9-]+) -->/g)].map((m) => m[1] ?? '');
}

if (import.meta.main) {
  const guide = join(resolve(import.meta.dirname, '../../..'), 'docs', 'self-host.md');
  const markers = screenshotMarkers(readFileSync(guide, 'utf8'));
  for (const name of markers) console.log(`${name}: ${SOURCES[name] ?? '(no source listed)'}`);
  console.log('\nCapturing is not implemented yet (see the comment at the top of this file).');
  process.exitCode = markers.every((m) => m in SOURCES) ? 0 : 1;
}
