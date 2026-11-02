// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of "Go live" from the web through the user hub
// (helper/README.md "Local end-to-end loop" sets up the API and the dev users; the helper runs
// `openlive-helper run` instead of `test-stream`).
//
// Drives headless Chrome through Vite (:5179) as DEV_AUTH users (the `openlive_dev_user` cookie):
//
//   1. The streamer opens the room and clicks "Go live". Their only helper is picked by itself;
//      its sources arrive with the test pattern's thumbnail (helper.sourceThumbnail, only to this
//      tab). They pick the test pattern, keep the default preset and sound (its tone) and start.
//   2. The live controls show "You are live" and stats for nerds from helper.stats.
//   3. A second browser context (a viewer) opens the room, clicks the stream card and plays it:
//      video frames keep growing.
//   4. The streamer pauses (privacy curtain): the viewer's player shows the curtain screen.
//      Resume: frames grow again.
//   5. The streamer changes the preset to text: the viewer still plays (the resolution changes
//      in-band), and the card shows the new preset.
//   6. The streamer stops: the viewer's player shows the ended screen and "Go live" is back.
//
//   ROOM_PATH=/s/dev/r/helper STREAMER=u_host VIEWER=u_view [SOURCE='Test pattern'] \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/go-live.mjs

/* global document */
import { createRequire } from 'node:module';
import path from 'node:path';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const ROOM_PATH = env('ROOM_PATH');
const STREAMER = env('STREAMER');
const VIEWER = env('VIEWER');
// The source button to pick: the test backend's pattern, or a Linux backend pseudo-source
// ("Choose a screen in the system dialog", with `run --test-pattern` to skip the dialog).
const SOURCE = env('SOURCE', 'Test pattern');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok: ${message}`);
}

async function person(browser, userId) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  await context.addCookies([{ name: 'openlive_dev_user', value: userId, url: WEB }]);
  const page = await context.newPage();
  const hubFrames = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws/hub')) return;
    ws.on('framereceived', (f) => hubFrames.push(String(f.payload)));
  });
  page.on('pageerror', (e) => log(userId, 'page error', e.message));
  return { userId, context, page, hubFrames };
}

async function openRoom(p) {
  await p.page.goto(WEB + ROOM_PATH);
  await p.page.locator('[data-rtc]').waitFor({ timeout: 20000 });
  const skip = p.page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
}

async function shot(p, name) {
  if (SCREENSHOTS) await p.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

const videoFrames = (p) =>
  p.page.evaluate(() => {
    const video = document.querySelector('video');
    return video ? video.getVideoPlaybackQuality().totalVideoFrames : null;
  });

async function framesGrow(p, label) {
  // Allow a few seconds for the first frames after a (re)pull.
  for (let i = 0; i < 20; i++) {
    const a = await videoFrames(p);
    await sleep(750);
    const b = await videoFrames(p);
    if (a !== null && b !== null && b > a) {
      check(true, `${label}: frames grow (${a} → ${b})`);
      return;
    }
  }
  check(false, `${label}: frames grow`);
}

const screenOf = (p) => p.page.locator('[role="region"][data-screen]').first();

async function waitScreen(p, kind, label) {
  await p.page
    .locator(`[role="region"][data-screen="${kind}"]`)
    .first()
    .waitFor({ timeout: 15000 });
  check(true, `${label}: the player shows "${kind}"`);
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  // 1. Go live from the web.
  const s = await person(browser, STREAMER);
  await openRoom(s);
  const goLive = s.page.getByRole('button', { name: 'Go live' });
  await goLive.waitFor({ timeout: 15000 });
  await shot(s, '1-room');
  const clicked = Date.now();
  await goLive.click();
  const source = s.page.getByRole('button', { name: SOURCE, exact: true });
  await source.waitFor({ timeout: 10000 });
  log(`sources listed ${Date.now() - clicked} ms after the click`);
  if (SOURCE === 'Test pattern') {
    const thumb = source.locator('img');
    await thumb.waitFor({ timeout: 5000 });
    const src = await thumb.getAttribute('src');
    check(src?.startsWith('data:image/jpeg;base64,'), 'the source has its thumbnail (data: URL)');
  }
  await shot(s, '2-sources');
  await source.click();
  if (SOURCE === 'Test pattern') {
    const sound = await s.page.getByRole('combobox', { name: 'Sound' }).innerText();
    check(sound.includes("This app's sound"), 'the test tone is offered and chosen by default');
  }
  await shot(s, '3-options');
  const started = Date.now();
  await s.page.getByRole('button', { name: 'Start streaming' }).click();
  const live = s.page.locator('[data-testid="golive-live"][data-state="live"]');
  await live.waitFor({ timeout: 30000 });
  log(`live ${Date.now() - started} ms after Start`);
  // 2. Stats for nerds from helper.stats.
  await s.page.getByTestId('golive-stats').waitFor({ timeout: 10000 });
  const stats = await s.page.getByTestId('golive-stats').innerText();
  log('stats:', stats.replace(/\s+/g, ' '));
  check(/fps/.test(stats), 'the streamer sees stats for nerds');
  await shot(s, '4-live');

  // 3. A viewer watches.
  const v = await person(browser, VIEWER);
  await openRoom(v);
  const card = v.page.getByRole('button', { name: /^Watch .* stream$/ }).first();
  await card.waitFor({ timeout: 15000 });
  await card.click();
  await framesGrow(v, 'viewer');
  await shot(v, '5-viewer');
  const thumbsToViewer = v.hubFrames.filter((f) => f.includes('helper.sourceThumbnail')).length;
  check(thumbsToViewer === 0, 'no picker thumbnail reached the viewer');

  // Steady state (the first second after the start flushes frames queued during the publish).
  log('stats now:', (await s.page.getByTestId('golive-stats').innerText()).replace(/\s+/g, ' '));

  // 4. Privacy curtain from the web, then resume.
  await s.page.getByRole('button', { name: 'Pause (privacy curtain)' }).click();
  await s.page
    .locator('[data-testid="golive-live"][data-state="paused"]')
    .waitFor({ timeout: 10000 });
  await waitScreen(v, 'curtain', 'viewer after pause');
  await shot(v, '6-curtain');
  await s.page.getByRole('button', { name: 'Resume' }).click();
  await live.waitFor({ timeout: 10000 });
  await framesGrow(v, 'viewer after resume');

  // 5. Change the preset while live.
  await s.page.getByRole('combobox', { name: 'Quality' }).click();
  await s.page.getByRole('option', { name: 'Text and code' }).click();
  await s.page
    .locator('[data-testid="golive-live"]')
    .getByRole('combobox', { name: 'Quality' })
    .filter({ hasText: 'Text and code' })
    .waitFor({ timeout: 15000 });
  await framesGrow(v, 'viewer after the preset change');
  await v.page
    .getByText(/^1080p30/)
    .first()
    .waitFor({ timeout: 10000 });
  check(true, 'the card shows the new preset (1080p30)');

  // 6. Stop from the web.
  await s.page.getByRole('button', { name: 'Stop streaming' }).click();
  await goLive.waitFor({ timeout: 15000 });
  check(true, 'the streamer is back to "Go live"');
  await waitScreen(v, 'ended', 'viewer after stop');
  await shot(v, '7-ended');
  log('screen:', await screenOf(v).getAttribute('data-screen'));
  log('ALL GREEN');
} finally {
  await browser.close();
}
