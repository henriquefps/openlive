// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of the room presence in the space sidebar (docs/PROTOCOL.md 7.8) through
// the real app: two browser contexts in the same space, A in room A and B in room B.
//
//   1. B's tab keeps one space socket (/ws/spaces/:spaceId) for the sidebar, besides its room.
//   2. A joins voice in room A: B sees A under room A in the sidebar, while B stays in room B.
//   3. A mutes (deafens, without Realtime credentials): B sees the icon next to A.
//   4. A leaves voice: the row under room A empties.
//
// Setup as in helper/README.md "Local end-to-end loop" (API with DEV_AUTH, Vite proxying to it),
// with two users who are members of the space, and two rooms with voice:
//
//   ROOM_A=/s/friends/r/games ROOM_B=/s/friends/r/hangout ROOM_A_ID=<roomId> USER_A=u_ana \
//   USER_B=u_bia WEB=http://localhost:5179 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROME=/usr/bin/google-chrome-stable [SCREENSHOTS=/some/dir] node apps/web/e2e/space-presence.mjs

import { createRequire } from 'node:module';
import path from 'node:path';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const ROOM_A = env('ROOM_A');
const ROOM_B = env('ROOM_B');
const ROOM_A_ID = env('ROOM_A_ID');
const USER_A = env('USER_A');
const USER_B = env('USER_B');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok:', message);
}

async function person(browser, userId, roomPath) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    permissions: ['microphone'],
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: userId, domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();
  // Open sockets by path (React's StrictMode opens and closes one more in development).
  const sockets = [];
  page.on('websocket', (ws) => {
    const entry = { path: new URL(ws.url()).pathname, open: true };
    sockets.push(entry);
    ws.on('close', () => {
      entry.open = false;
    });
  });
  page.on('pageerror', (e) => log(userId, 'page error', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') log(userId, 'console error', m.text());
  });
  await page.goto(`${WEB}${roomPath}`);
  // The first visit shows the tutorial, which makes the rest of the page inert.
  const skip = page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
  return { userId, context, page, sockets };
}

/** Room A's people in B's sidebar. */
const sidebarRow = (page) => page.locator(`[data-testid="sidebar-room"][data-room="${ROOM_A_ID}"]`);

async function shot(p, name) {
  if (!SCREENSHOTS) return;
  await p.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  const b = await person(browser, USER_B, ROOM_B);
  const a = await person(browser, USER_A, ROOM_A);
  const nameA = await a.page.evaluate(async () => {
    const res = await fetch('/api/me');
    return (await res.json()).user.displayName;
  });

  // 1. One open space socket for the sidebar.
  await sidebarRow(b.page).waitFor();
  const spaceSockets = () =>
    b.sockets.filter((s) => s.open && s.path.startsWith('/ws/spaces/')).map((s) => s.path);
  for (let i = 0; i < 50 && spaceSockets().length === 0; i++) await b.page.waitForTimeout(100);
  check(spaceSockets().length === 1, `${USER_B} has one open space socket (${spaceSockets()[0]})`);
  check(
    (await sidebarRow(b.page).locator('[data-testid="sidebar-room-people"]').count()) === 0,
    `${USER_B}: nobody under room A yet`,
  );

  // 2. A joins voice in room A; B, in room B, sees A under room A.
  const join = a.page.getByRole('button', { name: 'Join voice' }).first();
  await join.waitFor();
  const t0 = Date.now();
  await join.click();
  await a.page.getByRole('toolbar', { name: 'Voice controls' }).first().waitFor();
  log(USER_A, `in voice after ${Date.now() - t0} ms`);
  const entry = sidebarRow(b.page)
    .locator('[data-testid="sidebar-room-people"] li')
    .filter({ hasText: nameA });
  await entry.waitFor({ timeout: 10_000 });
  log(USER_B, `sees ${USER_A} under room A ${Date.now() - t0} ms after the click`);
  check(new URL(b.page.url()).pathname === ROOM_B, `${USER_B} is still in room B`);
  check(true, `${USER_B} sees ${nameA} in room A's voice in the sidebar`);
  await shot(b, 'space-presence-b-sees-a');

  // 3. A mutes (or, without Realtime credentials, where the microphone never starts and Mute is
  // disabled, deafens): the icon appears in B's sidebar.
  const mute = a.page.getByRole('button', { name: 'Mute', exact: true }).first();
  const [button, icon] = (await mute.isEnabled())
    ? [mute, 'Muted']
    : [a.page.getByRole('button', { name: 'Deafen', exact: true }).first(), 'Deafened'];
  await button.click();
  await entry.getByRole('img', { name: icon }).waitFor({ timeout: 10_000 });
  check(true, `${USER_B} sees ${nameA} ${icon.toLowerCase()}`);
  await shot(b, 'space-presence-b-sees-a-muted');

  // 4. A leaves: the row empties.
  await a.page
    .getByRole('toolbar', { name: 'Voice controls' })
    .first()
    .getByRole('button', { name: 'Disconnect', exact: true })
    .first()
    .click();
  await sidebarRow(b.page)
    .locator('[data-testid="sidebar-room-people"]')
    .waitFor({ state: 'detached', timeout: 10_000 });
  check(true, `${USER_B}: room A is quiet again after ${USER_A} left`);
  check(spaceSockets().length === 1, `${USER_B} still has one open space socket`);
  log('PASSED');
} finally {
  await browser.close();
}
