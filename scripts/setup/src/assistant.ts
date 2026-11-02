// SPDX-License-Identifier: AGPL-3.0-only
// The secrets assistant: what to set up at Discord and Resend for the chosen address, and the
// parsing of the answers. The prompts themselves (hidden input) are in prompt.ts; main.ts runs
// the conversation. Values are never echoed: the prompts are muted and the messages name keys.

import { emailAddressOf } from './args.ts';

export const DISCORD_CALLBACK = '/api/auth/discord/callback';
export const DEV_ORIGIN = 'http://localhost:5179';

export type LoginMethod = 'discord' | 'email';

/** The OAuth2 redirects to add to the Discord application, production first. */
export function discordRedirects(origin: string): string[] {
  return [`${origin}${DISCORD_CALLBACK}`, `${DEV_ORIGIN}${DISCORD_CALLBACK}`];
}

/** `1`/discord, `2`/email, `3`/both; null when the answer is none of them. */
export function parseLoginChoice(answer: string): LoginMethod[] | null {
  const a = answer.trim().toLowerCase();
  if (a === '1' || a === 'discord') return ['discord'];
  if (a === '2' || a === 'email' || a === 'e-mail') return ['email'];
  if (a === '3' || a === 'both' || a === '') return ['discord', 'email'];
  return null;
}

export function discordInstructions(origin: string): string {
  const [prod, dev] = discordRedirects(origin);
  return [
    'Discord login:',
    '  1. https://discord.com/developers/applications → New Application (any name, e.g. Openlive).',
    '  2. OAuth2 → Redirects → add exactly:',
    `       ${prod}`,
    `     and, only if you also run Openlive locally for development:`,
    `       ${dev}`,
    '     Save changes.',
    '  3. Copy the Client ID and the Client Secret (Reset Secret shows it once).',
  ].join('\n');
}

export function emailInstructions(emailFrom: string | null): string {
  const sender = emailFrom ? emailAddressOf(emailFrom) : null;
  const domain = sender?.slice(sender.lastIndexOf('@') + 1) ?? null;
  const lines = [
    'E-mail login (magic link through Resend):',
    '  1. https://resend.com → API Keys → Create API Key, permission "Sending access".',
  ];
  if (domain) {
    lines.push(
      `  2. Domains → Add Domain → ${domain}, add the DNS records it shows (in the Cloudflare`,
      `     dashboard of that zone), and wait for "Verified". Until then Resend only delivers`,
      `     to your own address. The sender is ${emailFrom}.`,
    );
  } else {
    lines.push(
      '  2. Resend sends only from a domain you verified there. A workers.dev address has no',
      '     domain of yours: run the setup with --email-from "Openlive <login@your-domain>" on a',
      "     domain verified in Resend, or use Discord login. Without it, Resend's test sender only",
      '     reaches your own address.',
    );
  }
  return lines.join('\n');
}

export const ANALYTICS_INSTRUCTIONS = [
  'Optional, real usage in the meter (Enter skips it):',
  '  dashboard → My Profile → API Tokens → Create Token → Custom token, permission',
  '  Account → Account Analytics → Read, for this account only. Without it the meter uses the',
  '  estimate only.',
].join('\n');

/** The domain part of the sender, for the Resend domain check. */
export function senderDomain(emailFrom: string | null): string | null {
  const addr = emailFrom ? emailAddressOf(emailFrom) : null;
  return addr ? addr.slice(addr.lastIndexOf('@') + 1).toLowerCase() : null;
}
