// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// Discord OAuth 2.0: authorization code with PKCE. Scopes `identify` and `email`;
// the e-mail is only used when Discord says it is verified.

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
export const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
export const DISCORD_SCOPES = 'identify email';

export interface DiscordProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** Lowercased, and only when Discord verified it. */
  verifiedEmail: string | null;
}

export const callbackPath = '/api/auth/discord/callback';

export function authorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    scope: DISCORD_SCOPES,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    // Someone who already authorized the app is sent straight back, no consent screen.
    prompt: 'none',
  }).toString();
  return url.toString();
}

const tokenResponse = z.object({ access_token: z.string().min(1), token_type: z.string() });

const userResponse = z.object({
  id: z.string().regex(/^\d{1,32}$/),
  username: z.string(),
  global_name: z.string().nullish(),
  avatar: z
    .string()
    .regex(/^(a_)?[0-9a-f]{1,64}$/)
    .nullish(),
  email: z.string().nullish(),
  verified: z.boolean().nullish(),
});

/** Exchanges the authorization code (and the PKCE verifier) for an access token. */
export async function exchangeCode(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: env.DISCORD_CLIENT_ID ?? '',
      client_secret: env.DISCORD_CLIENT_SECRET ?? '',
    }),
  });
  if (!res.ok) throw new Error(`Discord token endpoint answered ${res.status}`);
  const parsed = tokenResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('Discord token response has an unexpected shape');
  return parsed.data.access_token;
}

export async function fetchProfile(accessToken: string): Promise<DiscordProfile> {
  const res = await fetch(DISCORD_USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Discord user endpoint answered ${res.status}`);
  const parsed = userResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('Discord user response has an unexpected shape');
  const u = parsed.data;
  const email = u.email?.trim().toLowerCase();
  return {
    id: u.id,
    displayName: (u.global_name?.trim() || u.username).slice(0, 80),
    avatarUrl: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
      : null,
    verifiedEmail:
      u.verified === true && email && z.email().safeParse(email).success ? email : null,
  };
}
