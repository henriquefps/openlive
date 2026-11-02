// SPDX-License-Identifier: AGPL-3.0-only
// Drives headless Chrome through the web app (Vite) and writes one optimized image per screen,
// theme and width: `<name>-<light|dark>.png`, plus `-mobile` for the 390 px shots.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import sharp from 'sharp';
import { api, setTutorial, USERS, type UserKey } from './seed.ts';
import { log, sleep, WEB } from './stack.ts';

type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

interface Options {
  out: string;
  /** Whether streams can go live (dev Realtime credentials); without it, no room or player. */
  live: boolean;
}

export async function capture({ out, live }: Options): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env['CHROME'] ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars',
      // Voice and cameras: Chrome's fake microphone and camera, allowed without a prompt.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const contexts = new Map<string, Page>();
  /** One page per user, theme and width, reused across shots so live connections stay up. */
  async function as(user: UserKey | null, theme: Theme, mobile = false, tag = ''): Promise<Page> {
    const key = `${user}-${theme}-${mobile}${tag}`;
    const existing = contexts.get(key);
    if (existing) return existing;
    const context: BrowserContext = await browser.newContext({
      viewport: mobile ? MOBILE : DESKTOP,
      deviceScaleFactor: mobile ? 2 : 1,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: theme,
      locale: 'en-US',
      reducedMotion: 'reduce',
    });
    await context.grantPermissions(['microphone', 'camera'], { origin: WEB });
    if (user) {
      await context.addCookies([{ name: 'openlive_dev_user', value: USERS[user].id, url: WEB }]);
    }
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`${key}: page error`, e.message));
    contexts.set(key, page);
    return page;
  }

  async function shot(
    page: Page,
    name: string,
    theme: Theme,
    { mobile = false, height = 0 } = {},
  ): Promise<void> {
    await page.mouse.move(0, 0);
    await settle(page);
    const file = join(out, `${name}${mobile ? '-mobile' : ''}-${theme}.png`);
    // `height` takes a taller slice of the page than the viewport.
    const clip = height ? { x: 0, y: 0, width: DESKTOP.width, height } : undefined;
    const raw = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: Boolean(clip),
      ...(clip ? { clip } : {}),
    });
    await optimize(raw, file);
    log(`${file.slice(out.length + 1)} (${Math.round(statSync(file).size / 1024)} KB)`);
  }

  const roomPath = (slug: string) => `/s/friends/r/${slug}`;
  // ONLY=rooms takes just the room shots (the voice, chat and player ones), for a quick check.
  const pages = process.env['ONLY'] !== 'rooms';

  try {
    for (const user of Object.keys(USERS) as UserKey[]) await setTutorial(user, false);
    if (pages) {
      // Signed out: the home page with the sign-in card.
      for (const theme of THEMES) {
        const page = await as(null, theme);
        await page.goto(`${WEB}/`);
        await page.getByRole('button').first().waitFor();
        await shot(page, 'sign-in', theme);
        const mobile = await as(null, theme, true);
        await mobile.goto(`${WEB}/`);
        await shot(mobile, 'sign-in', theme, { mobile: true });
      }

      // The admin onboarding wizard, while it is still pending (it opens on the first /admin).
      for (const theme of THEMES) {
        await api('ana', 'PUT', '/admin/onboarding', { step: 1, state: 'in_progress' });
        const page = await as('ana', theme);
        await page.goto(`${WEB}/admin/setup`);
        await page.locator('main').getByRole('button').first().waitFor();
        // Step 2, "Checks": every secret and binding of this instance, checked live.
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await page.getByRole('button', { name: 'Run again' }).waitFor();
        await shot(page, 'admin-setup', theme);
      }
      await api('ana', 'PUT', '/admin/onboarding', { step: 1, state: 'completed' });

      for (const theme of THEMES) {
        const page = await as('ana', theme);
        await page.goto(`${WEB}/spaces`);
        await page.getByText('Friends').first().waitFor();
        await shot(page, 'spaces', theme);

        await page.goto(`${WEB}/s/friends`);
        await page.getByText('Movie night').first().waitFor();
        await shot(page, 'space-rooms', theme);
        await page.locator('[data-tour="space-tab-members"]').click();
        await page.getByText('Carla').first().waitFor();
        await shot(page, 'space-members', theme);

        await page.goto(`${WEB}/admin`);
        await page.getByText('Book club').first().waitFor();
        await shot(page, 'admin-overview', theme);
        await page.goto(`${WEB}/admin/settings`);
        await page.locator('[data-tour="admin-settings-budget"]').waitFor();
        // Down to the monthly limit cards, below the ceilings and the cost calculator.
        await shot(page, 'admin-settings', theme, { height: 1360 });
        await page.goto(`${WEB}/admin/users`);
        await page.getByText('Diego').first().waitFor();
        await shot(page, 'admin-users', theme);
      }

      // The interactive tutorial, as Carla on her first visit to the space.
      for (const theme of THEMES) {
        await setTutorial('carla', true);
        const page = await as('carla', theme, false, '-tutorial');
        await page.goto(`${WEB}/s/friends`);
        await page.getByRole('button', { name: "Don't show tutorials again" }).waitFor();
        await sleep(500);
        await shot(page, 'tutorial', theme);
        await page.context().close();
      }
      await setTutorial('carla', false);
    }

    if (!live) {
      log('no live stream: skipping the room, player and Go live shots');
      return;
    }

    // Go live: Ana's helper is picked by itself; pick the test pattern and show the options.
    for (const theme of THEMES) {
      const page = await as('ana', theme);
      await page.goto(WEB + roomPath('movie-night'));
      await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Go live' }).click();
      const source = page.getByRole('button', { name: 'Test pattern', exact: true });
      await source.locator('img').waitFor({ timeout: 20_000 });
      await source.click();
      await page.getByRole('button', { name: 'Start streaming' }).waitFor();
      await shot(page, 'go-live', theme);
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Start streaming' }).click();
        await page
          .locator('[data-testid="golive-live"][data-state="live"]')
          .waitFor({ timeout: 30_000 });
      }
    }
    // Bruno (camera on) and Diego in voice in "Movie night", and a few chat messages.
    const bruno = await as('bruno', 'light', false, '-bg');
    const diego = await as('diego', 'dark', false, '-bg');
    await inVoice(bruno, 'movie-night', true);
    await inVoice(diego, 'movie-night', false);
    await say(bruno, 'Starting in 5 minutes, grab your snacks');
    await say(diego, 'On my way! @Ana are you streaming the trailer?');
    await say(bruno, 'The test pattern is live too, for the sound check');
    // Let the stream tiles get their first thumbnails.
    await sleep(8_000);

    for (const theme of THEMES) {
      // Watch together on desktop: in voice with the others, two live streams, the chat open.
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('movie-night'));
      await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await joinVoice(page);
      await waitForThumbnails(page, 2);
      await waitForCamera(page);
      await shot(page, 'room', theme);

      // Focus mode: the stream big, the other tiles as a strip below.
      await page.getByRole('button', { name: /^Watch Bruno.* stream$/ }).click();
      await page.locator('[data-ttff-ms]').waitFor({ timeout: 20_000 });
      await sleep(3_000);
      await page.locator('[data-slot="player-controls"]').hover();
      await page.getByRole('button', { name: 'Stats for nerds (I)' }).click();
      await sleep(2_500);
      await page.locator('[data-slot="player-controls"]').hover();
      await shot(page, 'player', theme);
      await page.context().close();
      contexts.delete(`carla-${theme}-false`);

      // The same on a phone: the tiles, the voice bar at the bottom, the chat over the page.
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('movie-night'));
      await mobile.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await joinVoice(mobile);
      await waitForThumbnails(mobile, 2);
      await waitForCamera(mobile);
      await shot(mobile, 'room', theme, { mobile: true });
      await mobile.getByTestId('chat-toggle').click();
      await mobile.getByRole('dialog', { name: 'Chat' }).waitFor();
      await shot(mobile, 'room-chat-sheet', theme, { mobile: true });
      await mobile.keyboard.press('Escape');
      await mobile.getByRole('button', { name: /^Watch Ana.* stream$/ }).click();
      await mobile.locator('[data-ttff-ms]').waitFor({ timeout: 20_000 });
      await sleep(3_000);
      await shot(mobile, 'player', theme, { mobile: true });
      await mobile.context().close();
      contexts.delete(`carla-${theme}-true`);
    }

    // A voice channel ("Hangout"): everyone in voice as tiles, Bruno on camera.
    await inVoice(bruno, 'hangout', true);
    await inVoice(diego, 'hangout', false);
    for (const theme of THEMES) {
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('hangout'));
      await joinVoice(page);
      await waitForCamera(page);
      await shot(page, 'room-voice', theme);
      await page.context().close();
      contexts.delete(`carla-${theme}-false`);
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('hangout'));
      await joinVoice(mobile);
      await waitForCamera(mobile);
      await shot(mobile, 'room-voice', theme, { mobile: true });
      await mobile.context().close();
      contexts.delete(`carla-${theme}-true`);
    }

    // A text channel ("General"): the page is the chat.
    for (const [who, text] of [
      [bruno, 'Who is up for games on Friday?'],
      [diego, 'Me! I can bring the second controller'],
      [bruno, 'Great, https://example.com/schedule has the times'],
    ] as const) {
      await who.goto(WEB + roomPath('general'));
      await say(who, text);
    }
    for (const theme of THEMES) {
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('general'));
      await page.getByTestId('chat-message').first().waitFor();
      await shot(page, 'room-chat', theme);
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('general'));
      await mobile.getByTestId('chat-message').first().waitFor();
      await shot(mobile, 'room-chat', theme, { mobile: true });
    }
  } finally {
    await browser.close();
  }
  const total = readdirSync(out).reduce((sum, f) => sum + statSync(join(out, f)).size, 0);
  log(`${readdirSync(out).length} images, ${(total / 1024 / 1024).toFixed(2)} MB in ${out}`);
}

/** Joins the voice of the open room and waits until in (the headphones hint dismissed). */
async function joinVoice(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Join voice' }).first().click();
  await page
    .locator('[data-testid^="voice-connected-"][data-phase="joined"]')
    .waitFor({ timeout: 20_000 });
  const hint = page.getByRole('button', { name: "Don't show again" });
  if (await hint.isVisible().catch(() => false)) await hint.click();
}

/** Opens `slug` in `page`, joins its voice and, with `camera`, turns the camera on. */
async function inVoice(page: Page, slug: string, camera: boolean): Promise<void> {
  await page.goto(`${WEB}/s/friends/r/${slug}`);
  await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
  await joinVoice(page);
  if (camera) {
    await page.getByTestId('camera-toggle').first().click();
    await page.getByTestId('camera-on-air').first().waitFor({ timeout: 20_000 });
  }
}

/** Sends a chat message in the open room (desktop: the chat panel is open by default). */
async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole('combobox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
  await page.getByTestId('chat-message').filter({ hasText: text }).waitFor();
}

/** Waits until someone's camera plays in a tile. */
async function waitForCamera(page: Page): Promise<void> {
  const ok = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="camera-tile"] video')].some(
          (v) => (v as HTMLVideoElement).videoWidth > 0,
        ),
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) log('no camera video in the tiles');
}

/** Waits for fonts, pending images and a quiet network, so nothing is half-drawn. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  await sleep(400);
}

async function waitForThumbnails(page: Page, count: number): Promise<void> {
  const images = page.locator('img[src*="/thumbnail"]');
  for (let i = 0; i < 60; i++) {
    const loaded = await images.evaluateAll(
      (imgs) => imgs.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length,
    );
    if (loaded >= count) return;
    await sleep(500);
  }
  log(`only some of the ${count} stream thumbnails loaded`);
}

/** Palette PNG (256 colours, dithered): a fraction of the size, no visible loss for UI shots. */
async function optimize(raw: Buffer, file: string): Promise<void> {
  await sharp(raw)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toFile(file);
}
