// SPDX-License-Identifier: AGPL-3.0-only
// The mobile app's login against a local Worker (docs/PROTOCOL.md 11.6), as the
// app will do it: instance description, PKCE authorization, token, a hub socket opened with a
// ticket, then sign-out, which closes the socket. For `wrangler dev` with DEV_AUTH=1 only: the
// consent step stands in for the signed-in browser with the development identity header.
//
//   node apps/api/scripts/app-login-smoke.mjs http://localhost:8797 u_smoke

import { createHash, randomBytes } from 'node:crypto';

const [base = 'http://localhost:8790', userId = 'u_smoke'] = process.argv.slice(2);
const DEV_USER = 'X-Openlive-Dev-User';
const b64url = (buf) => buf.toString('base64url');

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

async function call(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Opens a socket and resolves once it opened or failed; records messages and the close. */
function openSocket(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));
  const opened = new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  return { ws, messages, closed, opened };
}

async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// 1. What the app checks before connecting.
const info = await call('GET', '/.well-known/openlive.json');
check(
  info.status === 200 && info.body.features.includes('app_login'),
  'well-known describes the instance',
);
console.log(`   ${JSON.stringify(info.body)}`);

// 2. PKCE: the app's verifier and challenge, then the person allows the app.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(12));
const allow = await call('POST', '/api/app/authorize', {
  headers: { [DEV_USER]: userId, Origin: base },
  body: {
    client: 'openlive-mobile',
    redirectUri: 'openlive://auth',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    deviceName: 'Smoke test phone',
  },
});
check(allow.status === 200, 'the person allows the app');
const redirect = new URL(allow.body.redirectTo);
check(
  redirect.protocol === 'openlive:' && redirect.host === 'auth',
  'redirect goes to openlive://auth',
);
check(redirect.searchParams.get('state') === state, 'state comes back unchanged');
const code = redirect.searchParams.get('code');

// 3. The app exchanges the code.
const tokenBody = {
  code,
  codeVerifier: verifier,
  client: 'openlive-mobile',
  redirectUri: 'openlive://auth',
};
const wrong = await call('POST', '/api/app/token', {
  body: { ...tokenBody, codeVerifier: b64url(randomBytes(32)) },
});
check(
  wrong.status === 400 && wrong.body.code === 'app_code_invalid',
  'a wrong verifier is refused',
);
// The wrong attempt burned that code: start again, as the app would.
const again = await call('POST', '/api/app/authorize', {
  headers: { [DEV_USER]: userId, Origin: base },
  body: {
    client: 'openlive-mobile',
    redirectUri: 'openlive://auth',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    deviceName: 'Smoke test phone',
  },
});
const code2 = new URL(again.body.redirectTo).searchParams.get('code');
const token = await call('POST', '/api/app/token', { body: { ...tokenBody, code: code2 } });
check(
  token.status === 200 && token.body.token.startsWith('ola_'),
  'the code and verifier give an app token',
);
const reused = await call('POST', '/api/app/token', { body: { ...tokenBody, code: code2 } });
check(reused.status === 400, 'the code works only once');
const bearer = { Authorization: `Bearer ${token.body.token}` };

// 4. The token on the REST API.
const me = await call('GET', '/api/me', { headers: bearer });
check(me.status === 200 && me.body.user.id === userId, 'GET /api/me with the app token');
const sessions = await call('GET', '/api/me/sessions', { headers: bearer });
check(
  sessions.body.sessions.some(
    (s) => s.kind === 'app' && s.current && s.deviceName === 'Smoke test phone',
  ),
  'Settings > Sessions lists the app',
);

// 5. A hub socket with a single-use ticket.
const ticket = await call('POST', '/api/app/ws-ticket', { headers: bearer });
check(ticket.status === 200 && ticket.body.ticket.startsWith('olt_'), 'a WebSocket ticket');
const wsBase = base.replace(/^http/, 'ws');
const hub = openSocket(`${wsBase}/ws/hub?ticket=${ticket.body.ticket}`);
check(await hub.opened, 'the hub socket opens with the ticket');
hub.ws.send(
  JSON.stringify({
    type: 'hello',
    id: '1',
    payload: {
      protocol: info.body.protocol.max,
      client: 'web',
      clientVersion: '0.1.0',
      tabId: 't_smoke',
    },
  }),
);
check(await until(() => hub.messages.find((m) => m.type === 'hub.welcome')), 'hub.welcome');
const replay = openSocket(`${wsBase}/ws/hub?ticket=${ticket.body.ticket}`);
check(!(await replay.opened), 'the same ticket is refused the second time');

// 6. Sign out from the app: the token stops and the socket closes with 4001.
const out = await call('DELETE', '/api/app/token', { headers: bearer });
check(out.status === 204, 'DELETE /api/app/token');
check(
  await until(() =>
    hub.messages.find((m) => m.type === 'error' && m.payload.code === 'session_expired'),
  ),
  'the hub socket hears session_expired',
);
check((await hub.closed) === 4001, 'the hub socket closes with 4001');
const after = await call('GET', '/api/me', { headers: bearer });
check(after.status === 401, 'the revoked token is refused');
console.log('all good');
