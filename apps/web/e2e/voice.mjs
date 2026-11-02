// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of the voice channel through the real
// Room page: two browser contexts, each with Chrome's fake microphone (a periodic beep), join
// voice and hear each other through the real SFU proxy routes and the dev Realtime app.
//
//   1. Both join (POST .../voice/publish, voice.tracks, POST .../voice/subscribe, PUT
//      .../renegotiate) and see each other in "In voice".
//   2. Each receives the other's audio: the pulled inbound-rtp audio track's totalAudioEnergy
//      grows, and the speaking ring (local level analysis) lights up on the other's avatar.
//   3. Mute: the other side sees the muted icon and the received energy stops growing.
//   4. Deafen: the deafened side's voice <audio> elements are muted, the other side sees the icon;
//      undeafen gives the earlier mute back.
//   5. Leave: POST .../voice/unpublish and the other side's roster empties.
//
// Setup as in helper/README.md "Local end-to-end loop" (API on :8790 with DEV_AUTH, Vite on
// :5179), with two users who are members of the room's space (no helper needed):
//
//   ROOM_PATH=/s/voice/r/watch USER_A=u_ana USER_B=u_bia \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/voice.mjs

/* global document, window */
import { createRequire } from 'node:module';
import path from 'node:path';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const ROOM_PATH = env('ROOM_PATH');
const USER_A = env('USER_A');
const USER_B = env('USER_B');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok:', message);
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

/** Received voice audio on the page: total energy and packets of the inbound audio tracks. */
async function inboundAudio(page) {
  return page.evaluate(async () => {
    let energy = 0;
    let packets = 0;
    let tracks = 0;
    for (const pc of window.__peers) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          tracks += 1;
          energy += s.totalAudioEnergy ?? 0;
          packets += s.packetsReceived ?? 0;
        }
      });
    }
    return { energy, packets, tracks };
  });
}

async function person(browser, userId) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    permissions: ['microphone'],
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: userId, domain: 'localhost', path: '/' },
  ]);
  await context.addInitScript(recordPeers);
  const page = await context.newPage();
  const requests = [];
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (
      url.pathname.startsWith('/api/rtc/') &&
      (url.pathname.includes('/voice/') || url.pathname.endsWith('/renegotiate'))
    ) {
      requests.push(`${r.method()} ${url.pathname.replace(/^\/api\/rtc\/rooms\/[^/]+/, '')}`);
    }
  });
  page.on('pageerror', (e) => log(userId, 'page error', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') log(userId, 'console error', m.text());
  });
  await page.goto(`${WEB}${ROOM_PATH}`);
  // The first visit shows the tutorial, which makes the rest of the page inert.
  const skip = page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
  return { userId, context, page, requests };
}

const row = (page, userId) =>
  page.locator(`[data-testid="in-voice"] [data-voice-user="${userId}"]`);

async function waitFor(fn, message, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`FAILED (timeout): ${message}`);
    await sleep(200);
  }
}

/** The energy received grows by more than `min` over `ms`. */
async function energyGrowth(page, ms = 3_000) {
  const before = await inboundAudio(page);
  await sleep(ms);
  const after = await inboundAudio(page);
  return { growth: after.energy - before.energy, packets: after.packets - before.packets, after };
}

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
  const a = await person(browser, USER_A);
  const b = await person(browser, USER_B);

  // 1. Join.
  for (const p of [a, b]) {
    const join = p.page.getByRole('button', { name: 'Join voice' }).first();
    await join.waitFor();
    await waitFor(() => join.isEnabled(), `${p.userId}: Join voice enabled`);
    const t0 = Date.now();
    await join.click();
    await p.page.getByRole('toolbar', { name: 'Voice controls' }).first().waitFor();
    log(p.userId, `in voice after ${Date.now() - t0} ms`);
  }
  for (const [p, other] of [
    [a, b],
    [b, a],
  ]) {
    await row(p.page, other.userId).waitFor();
    check(true, `${p.userId} sees ${other.userId} in voice`);
    await p.page.locator('[data-voice-status="sending"]').first().waitFor({ timeout: 15_000 });
    check(true, `${p.userId}: "Your microphone is on"`);
  }
  await waitFor(
    async () => (await inboundAudio(a.page)).tracks > 0 && (await inboundAudio(b.page)).tracks > 0,
    'both pulled an audio track',
  );
  check(a.requests.includes('POST /voice/publish'), `${USER_A} published (POST .../voice/publish)`);
  check(
    a.requests.includes('POST /voice/subscribe'),
    `${USER_A} pulled (POST .../voice/subscribe)`,
  );

  // 2. Each hears the other: energy grows, and the speaking ring lights up.
  for (const [p, other] of [
    [a, b],
    [b, a],
  ]) {
    const { growth, packets, after } = await energyGrowth(p.page);
    log(p.userId, `received audio: +${growth.toFixed(4)} energy, +${packets} packets`, after);
    check(growth > 0 && packets > 0, `${p.userId} receives ${other.userId}'s audio (energy > 0)`);
    await waitFor(
      async () => (await row(p.page, other.userId).getAttribute('data-speaking')) === 'true',
      `${p.userId} sees ${other.userId} speaking`,
    );
    check(true, `${p.userId} sees the speaking ring on ${other.userId}`);
  }
  await shot(a, 'voice-a-joined');
  await shot(b, 'voice-b-joined');

  // 3. B mutes: A sees the icon and stops receiving sound.
  await b.page.getByRole('button', { name: 'Mute', exact: true }).first().click();
  await row(a.page, USER_B).getByRole('img', { name: 'Muted' }).waitFor();
  check(true, `${USER_A} sees ${USER_B} muted`);
  await sleep(1_000);
  const muted = await energyGrowth(a.page);
  log(USER_A, `while ${USER_B} is muted: +${muted.growth.toFixed(6)} energy`);
  check(muted.growth < 1e-4, `${USER_A} hears silence while ${USER_B} is muted`);
  await waitFor(
    async () => (await row(a.page, USER_B).getAttribute('data-speaking')) === 'false',
    'the ring goes off while muted',
  );
  await b.page.getByRole('button', { name: 'Unmute' }).first().click();
  await waitFor(
    async () => (await row(a.page, USER_B).getByRole('img', { name: 'Muted' }).count()) === 0,
    `${USER_A} sees ${USER_B} unmuted`,
  );
  const unmuted = await energyGrowth(a.page);
  check(unmuted.growth > 0, `${USER_A} hears ${USER_B} again after unmute`);

  // 4. A deafens: its voice elements are muted, B sees the icon; undeafen restores.
  await a.page.getByRole('button', { name: 'Deafen' }).first().click();
  await row(b.page, USER_A).getByRole('img', { name: 'Deafened' }).waitFor();
  check(true, `${USER_B} sees ${USER_A} deafened`);
  const deafened = await a.page.evaluate(() =>
    [...document.querySelectorAll('audio[data-voice]')].map((e) => e.muted),
  );
  check(deafened.length > 0 && deafened.every(Boolean), `${USER_A}'s voice playback is silenced`);
  check(
    (await a.page.locator('[data-voice-status="deafened"]').count()) > 0,
    `${USER_A}'s microphone is off while deafened`,
  );
  await shot(a, 'voice-a-deafened');
  await a.page.getByRole('button', { name: 'Undeafen' }).first().click();
  await a.page.locator('[data-voice-status="sending"]').first().waitFor();
  const undeafened = await a.page.evaluate(() =>
    [...document.querySelectorAll('audio[data-voice]')].map((e) => e.muted),
  );
  check(
    undeafened.every((m) => !m),
    `${USER_A} hears again after undeafen (mute was off)`,
  );

  // 5. Leave (Disconnect in the "Voice connected" panel).
  await b.page.getByRole('button', { name: 'Disconnect', exact: true }).first().click();
  await b.page.getByRole('button', { name: 'Join voice' }).first().waitFor();
  await waitFor(async () => (await row(a.page, USER_B).count()) === 0, `${USER_B} left the roster`);
  await waitFor(
    () => b.requests.includes('POST /voice/unpublish'),
    `${USER_B} unpublished on leave`,
  );
  check(true, `${USER_B} unpublished on leave (POST .../voice/unpublish)`);
  log('requests', USER_A, a.requests.join(', '));
  log('requests', USER_B, b.requests.join(', '));
  log('PASS');
} catch (error) {
  if (SCREENSHOTS) {
    for (const [i, context] of browser.contexts().entries()) {
      await context
        .pages()[0]
        ?.screenshot({ path: path.join(SCREENSHOTS, `voice-failed-${i}.png`) })
        .catch(() => undefined);
    }
  }
  throw error;
} finally {
  await browser.close();
}
