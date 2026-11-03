// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEmailSenderForTests } from '../src/auth/email';
import { call, fixedRoom, migrate, newUser, setAccess, type World, world } from './api-helpers';
import {
  discordLogin,
  discordUser,
  FakeSender,
  json,
  location,
  newEmail,
  ORIGIN,
  send,
  setCookies,
  verify,
} from './auth-helpers';

// Invite-only sign-up (platform setting `signup`): both login methods × both
// modes × (existing account, new account with a valid invite or room code, an unusable one, none),
// the instance-claim exception, and e-mail neutrality. No login ever takes a use of an invite.

let mail: FakeSender;
let platformAdmin: string;

beforeAll(async () => {
  await migrate();
  // An instance with an admin cannot be claimed, so invite-only applies.
  platformAdmin = await newUser('padmin', { platformAdmin: true });
});
beforeEach(async () => {
  mail = new FakeSender();
  setEmailSenderForTests(mail);
  // world() creates its space as a regular user.
  await setAccess({ signup: 'invite_only', spaceCreation: 'members' });
});
afterEach(() => {
  setEmailSenderForTests(null);
  vi.restoreAllMocks();
});

// --- fixtures -------------------------------------------------------------------------------

interface InviteFixture {
  id: string;
  token: string;
}

async function invite(w: World, body: Record<string, unknown> = {}): Promise<InviteFixture> {
  const res = await call('POST', `/spaces/${w.spaceId}/invites`, w.owner, body);
  if (res.status !== 201) throw new Error(`invite failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.invite.id, token: res.body.token };
}

async function quickRoomCode(w: World): Promise<{ id: string; code: string }> {
  const res = await call('POST', '/rooms/quick', w.member, { spaceId: w.spaceId });
  if (res.status !== 201) throw new Error(`quick room failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.room.id, code: res.body.code };
}

const uses = async (inviteId: string) =>
  (
    await env.DB.prepare('SELECT uses FROM invites WHERE id = ?')
      .bind(inviteId)
      .first<{ uses: number }>()
  )?.uses;

/** The ways an invite context can be unusable, each with the code the login reports. */
const UNUSABLE: [string, (w: World) => Promise<{ invite?: string; roomCode?: string }>, string][] =
  [
    [
      'an expired invite',
      async (w) => {
        const i = await invite(w);
        await env.DB.prepare('UPDATE invites SET expires_at = 1 WHERE id = ?').bind(i.id).run();
        return { invite: i.token };
      },
      'invite_expired',
    ],
    [
      'a revoked invite',
      async (w) => {
        const i = await invite(w);
        await call('DELETE', `/invites/${i.id}`, w.owner);
        return { invite: i.token };
      },
      'invite_revoked',
    ],
    [
      'a used-up invite',
      async (w) => {
        const i = await invite(w);
        await env.DB.prepare('UPDATE invites SET uses = max_uses WHERE id = ?').bind(i.id).run();
        return { invite: i.token };
      },
      'invite_exhausted',
    ],
    [
      'a room invite to a closed room',
      async (w) => {
        const roomId = await fixedRoom(w);
        const i = await invite(w, { roomId });
        await env.DB.prepare('UPDATE rooms SET archived_at = 1 WHERE id = ?').bind(roomId).run();
        return { invite: i.token };
      },
      'room_closed',
    ],
    [
      'an invite to a suspended space',
      async (w) => {
        const i = await invite(w);
        await call('POST', `/admin/spaces/${w.spaceId}/suspend`, platformAdmin);
        return { invite: i.token };
      },
      'space_suspended',
    ],
    ['an unknown invite token', async () => ({ invite: 'x'.repeat(43) }), 'invite_not_found'],
    [
      'the code of an expired quick room',
      async (w) => {
        const room = await quickRoomCode(w);
        await env.DB.prepare('UPDATE rooms SET expires_at = 1 WHERE id = ?').bind(room.id).run();
        return { roomCode: room.code };
      },
      'room_closed',
    ],
    ['a code no room has', async () => ({ roomCode: 'OL-0000-0001' }), 'room_code_invalid'],
  ];

/** The ways an invite context is valid. */
const USABLE: [string, (w: World) => Promise<{ invite?: string; roomCode?: string }>][] = [
  ['a space invite', async (w) => ({ invite: (await invite(w)).token })],
  [
    'a room invite',
    async (w) => ({ invite: (await invite(w, { roomId: await fixedRoom(w) })).token }),
  ],
  [
    'an invite that needs approval',
    async (w) => ({ invite: (await invite(w, { requiresApproval: true })).token }),
  ],
  ['a quick room code', async (w) => ({ roomCode: (await quickRoomCode(w)).code })],
];

const userCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;

const identityOwner = (provider: string, providerUserId: string) =>
  env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?')
    .bind(provider, providerUserId)
    .first<{ user_id: string }>();

/** Gives a Discord account an existing user (as an earlier sign-up would have). */
async function existingDiscordUser(discordId: string): Promise<string> {
  const userId = await newUser('existing');
  await env.DB.prepare(
    `INSERT INTO identities (id, user_id, provider, provider_user_id, email, created_at)
     VALUES (?, ?, 'discord', ?, NULL, ?)`,
  )
    .bind(`id_${userId}`, userId, discordId, Date.now())
    .run();
  return userId;
}

async function existingEmailUser(email: string): Promise<string> {
  const userId = await newUser('existing');
  await env.DB.prepare('UPDATE users SET primary_email = ? WHERE id = ?').bind(email, userId).run();
  return userId;
}

const startEmail = (body: Record<string, unknown>) =>
  send('/api/auth/email/start', { method: 'POST', body: { returnTo: '/spaces', ...body } });

/** Runs the whole magic-link login; `sent` false when no e-mail went out. */
async function emailLogin(email: string, context: { invite?: string; roomCode?: string } = {}) {
  const start = await startEmail({
    email,
    ...(context.invite ? { invite: context.invite } : {}),
    ...(context.roomCode ? { code: context.roomCode } : {}),
  });
  expect(start.status).toBe(202);
  expect(await json(start)).toEqual({ sent: true });
  if (mail.sent.length === 0) return { sent: false as const };
  const res = await verify(mail.lastToken());
  return { sent: true as const, res };
}

function expectSession(res: Response) {
  expect(res.headers.get('Location')).not.toContain('authError');
  expect(setCookies(res)['__Host-ol_session']?.value).toBeTruthy();
}

function expectRefused(res: Response, code: string) {
  expect(location(res).toString()).toBe(`${ORIGIN}/?authError=${code}`);
  expect(setCookies(res)['__Host-ol_session']).toBeUndefined();
}

// --- the mobile app's /app/authorize as the return path -----------------------------------

describe('invite-only sign-up through the app authorization', () => {
  const appReturn = (extra: string) =>
    '/app/authorize?client=openlive-mobile&redirect_uri=openlive%3A%2F%2Fauth' +
    `&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256&state=${'s'.repeat(22)}` +
    `&device_name=Pixel%208${extra}`;

  it('creates a new account with the invite and lands back on /app/authorize', async () => {
    const w = await world();
    const { token } = await invite(w);
    const returnTo = appReturn(`&invite=${token}`);
    const profile = discordUser();
    const { res } = await discordLogin(profile, { returnTo, invite: token });
    expectSession(res);
    expect(`${location(res).pathname}${location(res).search}`).toBe(returnTo);
    expect(await identityOwner('discord', profile.id)).not.toBeNull();
  });

  it('creates a new account by e-mail with the invite, keeping the whole app query', async () => {
    const w = await world();
    const { token } = await invite(w);
    const returnTo = appReturn(`&invite=${token}`);
    const start = await startEmail({ email: newEmail(), returnTo, invite: token });
    expect(start.status).toBe(202);
    const res = await verify(mail.lastToken());
    expectSession(res);
    expect(`${location(res).pathname}${location(res).search}`).toBe(returnTo);
  });

  it('refuses a new account with an unusable invite', async () => {
    const profile = discordUser();
    const { res } = await discordLogin(profile, {
      returnTo: appReturn(`&invite=${'x'.repeat(43)}`),
      invite: 'x'.repeat(43),
    });
    expectRefused(res, 'invite_not_found');
  });

  it('refuses a new account with no invite', async () => {
    const profile = discordUser();
    const { res } = await discordLogin(profile, { returnTo: appReturn('') });
    expectRefused(res, 'signup_invite_required');
  });
});

// --- invite-only × Discord ------------------------------------------------------------------

describe('invite-only sign-up, Discord', () => {
  it('signs an existing account in, with no invite', async () => {
    const profile = discordUser();
    const userId = await existingDiscordUser(profile.id);
    const { res } = await discordLogin(profile);
    expectSession(res);
    expect((await identityOwner('discord', profile.id))?.user_id).toBe(userId);
  });

  it('refuses a new account with no invite: signup_invite_required, no users row', async () => {
    const profile = discordUser();
    const before = await userCount();
    const { res } = await discordLogin(profile);
    expectRefused(res, 'signup_invite_required');
    expect(await userCount()).toBe(before);
    expect(await identityOwner('discord', profile.id)).toBeNull();
  });

  for (const [name, make] of USABLE) {
    it(`creates a new account with ${name}, without using it`, async () => {
      const w = await world();
      const context = await make(w);
      const profile = discordUser();
      const { res } = await discordLogin(profile, {
        returnTo: '/invite/x',
        ...(context.invite ? { invite: context.invite } : {}),
        ...(context.roomCode ? { roomCode: context.roomCode } : {}),
      });
      expectSession(res);
      expect(location(res).pathname).toBe('/invite/x');
      expect(await identityOwner('discord', profile.id)).not.toBeNull();
      const { results } = await env.DB.prepare('SELECT uses FROM invites WHERE space_id = ?')
        .bind(w.spaceId)
        .all<{ uses: number }>();
      expect(results.every((r) => r.uses === 0)).toBe(true);
    });
  }

  for (const [name, make, code] of UNUSABLE) {
    it(`refuses a new account with ${name} (${code})`, async () => {
      const context = await make(await world());
      const profile = discordUser();
      const before = await userCount();
      const { res } = await discordLogin(profile, {
        ...(context.invite ? { invite: context.invite } : {}),
        ...(context.roomCode ? { roomCode: context.roomCode } : {}),
      });
      expectRefused(res, code);
      expect(await userCount()).toBe(before);
    });
  }

  it('keeps the invite in the signed state cookie, not the URL sent to Discord', async () => {
    const w = await world();
    const { token } = await invite(w);
    const res = await send(`/api/auth/discord/start?invite=${token}`);
    expect(location(res).toString()).not.toContain(token);
  });

  it('still offers the link when the verified e-mail belongs to an account (not a sign-up)', async () => {
    const email = newEmail();
    await existingEmailUser(email);
    const { res } = await discordLogin(discordUser({ email, verified: true }));
    expect(location(res).toString()).toBe(`${ORIGIN}/?auth=link_offer`);
  });
});

// --- invite-only × e-mail -------------------------------------------------------------------

describe('invite-only sign-up, e-mail magic link', () => {
  it('signs an existing account in, with no invite', async () => {
    const email = newEmail();
    await existingEmailUser(email);
    const login = await emailLogin(email);
    expect(login.sent).toBe(true);
    if (login.sent) expectSession(login.res);
  });

  it('sends nothing to an unknown address with no invite, and answers the same', async () => {
    const known = newEmail();
    await existingEmailUser(known);
    const unknown = newEmail();

    const a = await startEmail({ email: known });
    const b = await startEmail({ email: unknown });
    expect(b.status).toBe(a.status);
    expect(await json(b)).toEqual(await json(a));
    expect([...b.headers.keys()].sort()).toEqual([...a.headers.keys()].sort());
    expect(mail.sent.map((m) => m.to)).toEqual([known]);
    const tokens = await env.DB.prepare('SELECT 1 FROM email_tokens WHERE email = ?')
      .bind(unknown)
      .all();
    expect(tokens.results).toEqual([]);
    expect(
      await env.DB.prepare('SELECT 1 FROM users WHERE primary_email = ?').bind(unknown).first(),
    ).toBeNull();
  });

  for (const [name, make] of USABLE) {
    it(`creates a new account with ${name}, without using it`, async () => {
      const w = await world();
      const context = await make(w);
      const email = newEmail();
      const login = await emailLogin(email, context);
      expect(login.sent).toBe(true);
      if (!login.sent) return;
      expectSession(login.res);
      expect(await identityOwner('email', email)).not.toBeNull();
      // Tokens live in D1 only as hashes: the raw invite token is never stored.
      if (context.invite) {
        const rows = await env.DB.prepare('SELECT signup_json FROM email_tokens WHERE email = ?')
          .bind(email)
          .all<{ signup_json: string | null }>();
        expect(rows.results.length).toBeGreaterThan(0);
        for (const r of rows.results) {
          expect(r.signup_json).not.toContain(context.invite);
          expect(r.signup_json).toMatch(/"inviteHash":"[0-9a-f]{64}"/);
        }
      }
      const { results } = await env.DB.prepare('SELECT uses FROM invites WHERE space_id = ?')
        .bind(w.spaceId)
        .all<{ uses: number }>();
      expect(results.every((r) => r.uses === 0)).toBe(true);
    });
  }

  for (const [name, make] of UNUSABLE) {
    it(`sends nothing for a new address with ${name}, and answers the same`, async () => {
      const context = await make(await world());
      const login = await emailLogin(newEmail(), context);
      expect(login.sent).toBe(false);
    });
  }

  it('checks again when the link is used: an invite revoked meanwhile creates nothing', async () => {
    const w = await world();
    const i = await invite(w);
    const email = newEmail();
    const start = await startEmail({ email, invite: i.token });
    expect(start.status).toBe(202);
    await call('DELETE', `/invites/${i.id}`, w.owner);
    const res = await verify(mail.lastToken());
    expectRefused(res, 'invite_revoked');
    expect(await identityOwner('email', email)).toBeNull();
  });

  it('the invite is used only by accepting it, after the login', async () => {
    const w = await world();
    const i = await invite(w);
    const email = newEmail();
    const login = await emailLogin(email, { invite: i.token });
    if (!login.sent) throw new Error('no e-mail');
    const session = setCookies(login.res)['__Host-ol_session']?.value ?? '';
    expect(await uses(i.id)).toBe(0);
    const accept = await send(`/api/invites/${i.token}/accept`, {
      method: 'POST',
      cookies: { '__Host-ol_session': session },
    });
    expect(accept.status).toBe(200);
    expect(await uses(i.id)).toBe(1);
  });

  it('ignores a malformed invite or code instead of failing the request', async () => {
    const res = await startEmail({ email: newEmail(), invite: 'not a token', code: 'nope' });
    expect(res.status).toBe(202);
    expect(mail.sent).toEqual([]);
  });
});

// --- open mode ------------------------------------------------------------------------------

describe('open sign-up', () => {
  beforeEach(() => setAccess({ signup: 'open', spaceCreation: 'members' }));

  it('Discord creates a new account with no invite', async () => {
    const profile = discordUser();
    const { res } = await discordLogin(profile);
    expectSession(res);
    expect(await identityOwner('discord', profile.id)).not.toBeNull();
  });

  it('the e-mail link creates a new account with no invite', async () => {
    const email = newEmail();
    const login = await emailLogin(email);
    expect(login.sent).toBe(true);
    if (login.sent) expectSession(login.res);
  });

  it('a link sent while open is checked again if the policy changed before it is used', async () => {
    const email = newEmail();
    await startEmail({ email });
    await setAccess({ signup: 'invite_only', spaceCreation: 'members' });
    expectRefused(await verify(mail.lastToken()), 'signup_invite_required');
  });
});

// --- the first admin ------------------------------------------------------------------------

describe('before the instance has a platform admin', () => {
  beforeEach(() => env.DB.prepare('UPDATE users SET is_platform_admin = 0').run());
  afterEach(() =>
    env.DB.prepare('UPDATE users SET is_platform_admin = 1 WHERE id = ?').bind(platformAdmin).run(),
  );

  it('lets the first logins create accounts, so the owner can claim the instance', async () => {
    const profile = discordUser();
    const discord = await discordLogin(profile);
    expectSession(discord.res);

    const login = await emailLogin(newEmail());
    expect(login.sent).toBe(true);
    if (!login.sent) return;
    expectSession(login.res);
    // The claim still needs the install code.
    const session = setCookies(login.res)['__Host-ol_session']?.value ?? '';
    const claim = (code: string) =>
      send('/api/admin/claim', {
        method: 'POST',
        body: { code },
        cookies: { '__Host-ol_session': session },
      });
    expect((await claim('wrong')).status).toBe(403);
    expect((await claim('test-install-code')).status).toBe(200);
    // Now there is an admin: invite-only applies again.
    const late = await discordLogin(discordUser());
    expectRefused(late.res, 'signup_invite_required');
  });

  it('without an install code nobody can claim, so invite-only still applies', async () => {
    const noCode = { env: { INSTALL_CODE: undefined } };
    const res = await send('/api/auth/email/start', {
      method: 'POST',
      body: { email: newEmail() },
      ...noCode,
    });
    expect(res.status).toBe(202);
    expect(mail.sent).toEqual([]);
    expect(await json(await send('/api/auth/policy', noCode))).toEqual({ signup: 'invite_only' });
  });
});
