// SPDX-License-Identifier: AGPL-3.0-only
// Local check of the room page's layout (L5): the room is as tall as the screen below the top
// bar, so the page never scrolls on desktop, the chat's composer and the bottom bar stay in sight,
// and the voice controls are only the "Voice connected" panel (4 buttons on a phone). Carla opens
// "Movie night" (stream, voice, cameras, text) with 50 chat messages and Bruno and Diego in voice,
// at 1593×907 and 390×844 in light and dark, out of voice and then in it. It prints the
// measurements as JSON and, with SCREENSHOTS, saves a shot of each state.
//
// It brings up its own stack with the screenshot tooling (scripts/screenshots: wrangler dev with
// DEV_AUTH and a throwaway state, Vite, the fictional seed) on SHOTS_API_PORT/SHOTS_WEB_PORT
// (default 8806/5196). Voice needs the dev Realtime credentials, which wrangler reads with
// --env-file (OPENLIVE_DEV_VARS or the main checkout's .dev.vars; never read here).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] [NO_CHECKS=1] node apps/web/e2e/room-layout.mjs

/* global window, document */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SHOTS_API_PORT ??= '8806';
process.env.SHOTS_WEB_PORT ??= '5196';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { startStack, WEB } = await import(path.join(repo, 'scripts/screenshots/src/stack.ts'));
const { seed, setTutorial, USERS } = await import(
  path.join(repo, 'scripts/screenshots/src/seed.ts')
);
const require = createRequire(path.join(repo, 'scripts/screenshots/package.json'));
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
// Measure only (the page before this change fails the checks).
const CHECKS = !process.env.NO_CHECKS;

const DESKTOP = { width: 1593, height: 907 };
const PHONE = { width: 390, height: 844 };
const ROOM = '/s/friends/r/movie-night';
const MESSAGES = 50;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const failures = [];
function check(condition, message) {
  if (condition) log('ok:', message);
  else if (CHECKS) failures.push(message);
  else log('(not met):', message);
}

async function person(browser, user, { mobile = false, theme = 'light' } = {}) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: mobile ? PHONE : DESKTOP,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await context.grantPermissions(['microphone', 'camera'], { origin: WEB });
  await context.addCookies([{ name: 'openlive_dev_user', value: USERS[user].id, url: WEB }]);
  const page = await context.newPage();
  page.on('pageerror', (e) => log(user, 'page error', e.message));
  return { context, page };
}

async function open(page) {
  await page.goto(WEB + ROOM);
  await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
}

async function joinVoice(page) {
  await page.getByRole('button', { name: 'Join voice' }).first().click();
  await page
    .locator('[data-testid^="voice-connected-"][data-phase="joined"]')
    .waitFor({ timeout: 20_000 });
  const hint = page.getByRole('button', { name: "Don't show again" });
  if (await hint.isVisible().catch(() => false)) await hint.click();
}

async function say(page, text) {
  const box = page.getByRole('combobox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
  await page.getByTestId('chat-message').filter({ hasText: text }).waitFor();
}

/** What the page looks like now: its scroll height, the composer, the bars, the voice buttons. */
function measure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const rect = (el) => {
      if (!visible(el)) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const composer = document.querySelector('[role="combobox"][aria-label="Message"]');
    const bars = [...document.querySelectorAll('[data-testid$="bottom-bars"]')].find(visible);
    const toolbars = [...document.querySelectorAll('[role="toolbar"][aria-label="Voice controls"]')]
      .filter(visible)
      .map((t) => t.querySelectorAll('button').length);
    const controlBar = document.querySelector('[data-testid="room-controls"]');
    return {
      innerHeight: window.innerHeight,
      scrollHeight: document.scrollingElement.scrollHeight,
      composer: rect(composer),
      bottomBar: rect(bars),
      bottomBarButtons: bars ? [...bars.querySelectorAll('button')].filter(visible).length : 0,
      roomControlBar: rect(controlBar),
      voiceToolbars: toolbars,
      chatMessages: document.querySelectorAll('[data-testid="chat-message"]').length,
      micOnText: document.body.innerText.includes('Mic on'),
    };
  });
}

const stack = await startStack(repo);
let browser;
const results = {};
try {
  await seed(stack);
  for (const user of Object.keys(USERS)) await setTutorial(user, false);
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  // Bruno and Diego in voice; 50 messages from them and Ana (the chat allows 30 a minute each).
  const bruno = await person(browser, 'bruno');
  const diego = await person(browser, 'diego');
  const ana = await person(browser, 'ana');
  for (const p of [bruno, diego, ana]) await open(p.page);
  await joinVoice(bruno.page);
  await joinVoice(diego.page);
  const writers = [bruno, diego, ana];
  for (let i = 1; i <= MESSAGES; i += 1) {
    await say(
      writers[i % 3].page,
      `Message ${i}: who is bringing snacks for the movie tonight? I can bring popcorn.`,
    );
  }
  log(`${MESSAGES} messages sent, Bruno and Diego in voice`);

  for (const mobile of [false, true]) {
    for (const theme of ['light', 'dark']) {
      const name = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
      const carla = await person(browser, 'carla', { mobile, theme });
      await open(carla.page);
      // The chat is beside the stage on desktop; on a phone it opens over the page.
      if (!mobile) await carla.page.getByTestId('chat-message').first().waitFor();
      const out = await measure(carla.page);
      if (SCREENSHOTS) {
        await carla.page.screenshot({ path: path.join(SCREENSHOTS, `${name}-out.png`) });
      }
      await joinVoice(carla.page);
      // Three in voice now: Bruno, Diego and Carla.
      await carla.page
        .locator('[data-testid="in-voice"] [data-voice-user]')
        .nth(2)
        .waitFor({ timeout: 20_000 });
      await carla.page.waitForTimeout(800);
      const joined = await measure(carla.page);
      if (SCREENSHOTS) {
        await carla.page.screenshot({ path: path.join(SCREENSHOTS, `${name}-in.png`) });
      }
      results[name] = { outOfVoice: out, inVoice: joined };
      for (const [state, m] of [
        ['out of voice', out],
        ['in voice', joined],
      ]) {
        const where = `${name}, ${state}`;
        if (!mobile) {
          check(
            m.scrollHeight <= m.innerHeight + 1,
            `${where}: no page scroll (${m.scrollHeight} ≤ ${m.innerHeight} + 1)`,
          );
          check(
            m.composer !== null && m.composer.bottom <= m.innerHeight,
            `${where}: the composer is in sight`,
          );
        } else {
          check(
            m.scrollHeight <= m.innerHeight + 1,
            `${where}: no page scroll on the phone (${m.scrollHeight})`,
          );
        }
        check(m.roomControlBar === null, `${where}: no room control bar`);
        check(!m.micOnText, `${where}: no "Mic on" text`);
      }
      if (mobile) {
        check(
          joined.bottomBar !== null && joined.bottomBar.bottom <= joined.innerHeight,
          `${name}: the bottom bar is in the viewport`,
        );
        check(
          joined.bottomBarButtons === 4,
          `${name}: the bottom bar has exactly 4 voice buttons (${joined.bottomBarButtons})`,
        );
      }
      check(
        joined.voiceToolbars.length === 1 && joined.voiceToolbars[0] === 4,
        `${name}: one set of voice controls, 4 buttons (${JSON.stringify(joined.voiceToolbars)})`,
      );
      await carla.context.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (failures.length > 0) throw new Error(`FAILED:\n  ${failures.join('\n  ')}`);
  log('PASSED');
} finally {
  await browser?.close();
  stack.cleanup();
}
