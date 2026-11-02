// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of the app-wide voice session (voice that
// survives navigation): Ana joins voice in "Hangout", browses to "Movie night" and to Settings
// inside the app, and Bruno, still in Hangout, keeps receiving her audio (the inbound audio
// track's totalAudioEnergy keeps growing). The "Voice connected" panel leads her back to Hangout,
// where she is still in voice on the same room socket, with no second voice.join. The same on a
// phone-sized page, with the bar above the bottom of the screen.
//
// It brings up its own stack with the screenshot tooling (scripts/screenshots: wrangler dev with
// DEV_AUTH and a throwaway state, Vite, the fictional seed) on SHOTS_API_PORT/SHOTS_WEB_PORT
// (default 8804/5194). Live media needs the dev Realtime credentials, which wrangler reads with
// --env-file (OPENLIVE_DEV_VARS or the main checkout's .dev.vars; never read here).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/voice-navigation.mjs

/* global window */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SHOTS_API_PORT ??= '8804';
process.env.SHOTS_WEB_PORT ??= '5194';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { startStack, WEB } = await import(path.join(repo, 'scripts/screenshots/src/stack.ts'));
const { seed, setTutorial, USERS } = await import(
  path.join(repo, 'scripts/screenshots/src/seed.ts')
);
const require = createRequire(path.join(repo, 'scripts/screenshots/package.json'));
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok:', message);
}
async function waitFor(fn, message, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`FAILED (timeout): ${message}`);
    await sleep(200);
  }
}

/** Keeps every RTCPeerConnection the page creates, to read its stats. */
function recordPeers() {
  const Native = window.RTCPeerConnection;
  window.__peers = [];
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.__peers.push(this);
    }
  };
}

/** Received voice audio on the page: total energy of the inbound audio tracks. */
function inboundEnergy(page) {
  return page.evaluate(async () => {
    let energy = 0;
    for (const pc of window.__peers) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') energy += s.totalAudioEnergy ?? 0;
      });
    }
    return energy;
  });
}

/** Bruno's received energy grows while Ana is wherever she is. */
async function stillHeard(listener, where) {
  const before = await inboundEnergy(listener.page);
  await sleep(3_000);
  const growth = (await inboundEnergy(listener.page)) - before;
  check(growth > 0, `Bruno still hears Ana while she is ${where} (energy +${growth.toFixed(4)})`);
}

async function person(browser, user, mobile = false) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'reduce',
  });
  await context.grantPermissions(['microphone', 'camera'], { origin: WEB });
  await context.addCookies([{ name: 'openlive_dev_user', value: USERS[user].id, url: WEB }]);
  await context.addInitScript(recordPeers);
  const page = await context.newPage();
  // Room sockets and the voice.join frames sent on each.
  const sockets = [];
  page.on('websocket', (ws) => {
    const entry = { url: ws.url(), joins: 0, closed: false };
    sockets.push(entry);
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"voice.join"')) entry.joins += 1;
    });
    ws.on('close', () => (entry.closed = true));
  });
  page.on('pageerror', (e) => log(user, 'page error', e.message));
  return { user, context, page, sockets };
}

async function joinVoice(p, slug) {
  await p.page.goto(`${WEB}/s/friends/r/${slug}`);
  await p.page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
  await p.page.getByRole('button', { name: 'Join voice' }).first().click();
  await p.page.locator('[data-testid^="voice-connected-"][data-phase="joined"]').waitFor({
    timeout: 20_000,
  });
  const hint = p.page.getByRole('button', { name: "Don't show again" });
  if (await hint.isVisible().catch(() => false)) await hint.click();
}

async function shot(p, name) {
  if (!SCREENSHOTS) return;
  await p.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
  log('screenshot', name);
}

const stack = await startStack(repo);
let browser;
try {
  if (!stack.live) throw new Error('no dev Realtime credentials: live voice cannot be checked');
  const seeded = await seed(stack);
  for (const user of ['ana', 'bruno']) await setTutorial(user, false);
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const hangoutSocket = (p) => p.sockets.filter((s) => s.url.includes(seeded.rooms.hangout));

  // --- Desktop ---
  const bruno = await person(browser, 'bruno');
  const ana = await person(browser, 'ana');
  await joinVoice(bruno, 'hangout');
  await joinVoice(ana, 'hangout');
  // (Development builds mount twice, StrictMode: the first socket opens and closes at once.)
  const joinedOn = hangoutSocket(ana).filter((s) => !s.closed);
  check(joinedOn.length === 1, 'Ana is in voice on one open Hangout socket');
  const [live] = joinedOn;
  await waitFor(async () => (await inboundEnergy(bruno.page)) > 0, 'Bruno receives Ana');
  await stillHeard(bruno, 'in Hangout');

  // Another room, through the sidebar (no page load).
  await ana.page.getByTestId('sidebar-room').filter({ hasText: 'Movie night' }).click();
  await ana.page.getByRole('heading', { name: 'Movie night' }).waitFor();
  const panel = ana.page.getByTestId('voice-connected-sidebar');
  await panel.waitFor();
  check(
    (await panel.getAttribute('aria-label')) === 'Voice connected in Hangout',
    'the sidebar says "Voice connected" in Hangout from Movie night',
  );
  await stillHeard(bruno, 'in Movie night');
  await shot(ana, 'voice-connected-desktop-room');

  // Settings.
  await ana.page.getByRole('link', { name: 'Settings' }).click();
  await ana.page.waitForURL(/\/settings$/);
  await stillHeard(bruno, 'in Settings');
  await shot(ana, 'voice-connected-desktop-settings');

  // Back through the panel: still in voice, same socket, one voice.join.
  await panel.getByRole('link', { name: 'Go to Hangout' }).click();
  await ana.page.getByRole('heading', { name: 'Hangout' }).waitFor();
  await ana.page.locator('[data-testid^="voice-connected-"][data-phase="joined"]').waitFor();
  const sockets = hangoutSocket(ana);
  check(
    sockets.at(-1) === live && !live.closed,
    'back in Hangout on the same room socket (no new one, never closed)',
  );
  check(
    sockets.reduce((n, s) => n + s.joins, 0) === 1,
    'no second voice.join: Ana did not join again',
  );
  await stillHeard(bruno, 'back in Hangout');

  // Disconnect from the panel.
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await ana.page.getByTestId('join-voice').waitFor();
  check(!(await panel.isVisible()), 'disconnect leaves and hides the panel');
  await ana.context.close();

  // --- Phone ---
  const phone = await person(browser, 'ana', true);
  await joinVoice(phone, 'hangout');
  await waitFor(async () => (await inboundEnergy(bruno.page)) > 0, 'Bruno receives Ana (phone)');
  check(
    (await phone.page.getByTestId('voice-connected-bar').getByRole('button').count()) === 4,
    'on the room page itself the bottom bar is the panel with 4 buttons',
  );
  await phone.page.getByRole('button', { name: 'Toggle the sidebar' }).click();
  await phone.page.getByRole('link', { name: 'Settings' }).click();
  await phone.page.waitForURL(/\/settings$/);
  const bar = phone.page.getByTestId('voice-connected-bar');
  await bar.waitFor();
  check(
    (await bar.textContent())?.includes('Hangout') === true,
    'the phone bar says "Voice connected · Hangout" in Settings',
  );
  await stillHeard(bruno, 'in Settings on a phone');
  await shot(phone, 'voice-connected-mobile-settings');
  await bar.getByRole('link', { name: 'Go to Hangout' }).click();
  await phone.page.locator('[data-testid^="voice-connected-"][data-phase="joined"]').waitFor();
  check(
    hangoutSocket(phone).reduce((n, s) => n + s.joins, 0) === 1,
    'phone: back in Hangout without joining again',
  );
  log('PASSED');
} finally {
  await browser?.close();
  stack.cleanup();
}
