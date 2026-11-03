// SPDX-License-Identifier: AGPL-3.0-only
// Drives headless Chrome through the web app (Vite) and writes one optimized image per screen,
// theme and width: `<name>-<light|dark>.png`, plus `-mobile` for the 390 px shots.
//
// Every page gets a fake camera and microphone (fakeMedia below): the camera is that person's
// cam-<name> picture, drawn on a canvas with a slow zoom and sent as a real video track, and the
// microphone is a tone that only the person set to speak makes audible, so the speaking ring
// lands on one tile. Chrome's own fake devices only fill the device lists.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import sharp from 'sharp';
import { type Assets, camDataUrl } from './assets.ts';
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
  assets: Assets;
  /** The label of the source Ana's helper offers in Go live (its --test-label). */
  goLiveSource: string;
}

export async function capture({ out, live, assets, goLiveSource }: Options): Promise<void> {
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
  const cams = new Map<UserKey, string>();
  for (const user of Object.keys(USERS) as UserKey[]) {
    cams.set(user, await camDataUrl(assets.cam[user]));
  }
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
      await context.addInitScript(fakeMedia, cams.get(user) ?? '');
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
    { mobile = false, height = 0, keepMouse = false } = {},
  ): Promise<void> {
    // The mouse out of the way, unless it holds something open (the player's menu).
    if (!keepMouse) await page.mouse.move(0, 0);
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
        await page.getByText('Felipe').first().waitFor();
        await waitForAvatars(page);
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
        await waitForAvatars(page);
        await shot(page, 'admin-users', theme);

        // The Download page: the helper and the Android app, linked to the GitHub releases.
        await page.goto(`${WEB}/download`);
        await page
          .locator('a[href^="https://github.com/"][href*="/releases/download/"]')
          .first()
          .waitFor();
        await shot(page, 'download', theme, { height: 1300 });

        // On a phone: the users table as a card list, and a form dialog as a bottom sheet.
        const mobile = await as('ana', theme, true);
        await mobile.goto(`${WEB}/admin/users`);
        await mobile.getByText('Felipe').first().waitFor();
        await waitForAvatars(mobile);
        await shot(mobile, 'admin-users', theme, { mobile: true });
        await mobile.goto(`${WEB}/s/friends`);
        await mobile.getByText('Movie night').first().waitFor();
        await mobile.getByRole('button', { name: 'Create room' }).first().click();
        await mobile.getByRole('dialog').waitFor();
        await mobile.locator('#room-name').fill('Watch party');
        await sleep(400);
        await shot(mobile, 'room-create-sheet', theme, { mobile: true });
        await mobile.keyboard.press('Escape');
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

    // Go live in "Games": Ana's helper is picked by itself and lists its screen with a preview.
    // The dark run then picks it and starts, so "Games" has Ana's game on from here on.
    for (const theme of THEMES) {
      const page = await as('ana', theme);
      await page.goto(WEB + roomPath('games'));
      await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Go live' }).click();
      const source = page.getByRole('button', { name: goLiveSource, exact: true });
      await source.locator('img').waitFor({ timeout: 20_000 });
      await source.scrollIntoViewIfNeeded();
      await shot(page, 'go-live', theme);
      if (theme === 'dark') {
        await source.click();
        await page.getByRole('button', { name: 'Start streaming' }).click();
        await page
          .locator('[data-testid="golive-live"][data-state="live"]')
          .waitFor({ timeout: 30_000 });
      }
    }

    // The others, each in a page of their own kept open in the background.
    const bg = {} as Record<Exclude<UserKey, 'carla'>, Page>;
    for (const user of ['ana', 'bruno', 'diego', 'eva', 'felipe'] as const) {
      bg[user] = await as(user, 'light', false, '-bg');
    }

    // "Movie night": Bruno streams the movie; Bruno, Diego and Eva on camera, Ana and Felipe
    // in voice only, Diego speaking, a few chat messages.
    await inVoice(bg.bruno, 'movie-night', true);
    await inVoice(bg.diego, 'movie-night', true);
    await inVoice(bg.eva, 'movie-night', true);
    await inVoice(bg.felipe, 'movie-night', false);
    await inVoice(bg.ana, 'movie-night', false);
    await speak(bg.diego, true);
    await say(bg.bruno, 'Starting in 5 minutes, grab your snacks');
    await say(bg.eva, 'Popcorn is ready, saving the good seat');
    await say(bg.diego, '@Bruno can you turn the volume up a little?');
    await say(bg.felipe, 'Joining from the couch, camera off today');
    // Let the stream tile get its first thumbnail.
    await sleep(8_000);

    for (const theme of THEMES) {
      // Watch together on desktop: the stream and the cameras on the stage, the chat open.
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('movie-night'));
      await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await joinVoice(page, true);
      await waitForThumbnails(page, 1);
      await waitForCameras(page, 4);
      await waitForSpeaking(page, USERS.diego.id);
      await shot(page, 'room', theme);

      // Watching: the movie big, the others as a strip below, the quality menu open.
      await page.getByRole('button', { name: /^Watch Bruno.* stream$/ }).click();
      await page.locator('[data-ttff-ms]').waitFor({ timeout: 20_000 });
      await sleep(3_000);
      await page.locator('[data-slot="player-controls"]').hover();
      await page.getByRole('button', { name: 'Quality', exact: true }).click();
      await page.getByRole('menu').waitFor();
      await sleep(500);
      await shot(page, 'player', theme, { keepMouse: true });
      await page.context().close();
      contexts.delete(`carla-${theme}-false`);

      // The same on a phone: the stage, the voice bar at the bottom, the chat as a sheet.
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('movie-night'));
      await mobile.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
      await joinVoice(mobile, true);
      await waitForThumbnails(mobile, 1);
      await waitForCameras(mobile, 3);
      await shot(mobile, 'room', theme, { mobile: true });
      await mobile.getByTestId('chat-toggle').click();
      await mobile.getByRole('dialog', { name: 'Chat' }).waitFor();
      await shot(mobile, 'room-chat-sheet', theme, { mobile: true });
      await mobile.keyboard.press('Escape');
      await mobile.getByRole('button', { name: /^Watch Bruno.* stream$/ }).click();
      await mobile.locator('[data-ttff-ms]').waitFor({ timeout: 20_000 });
      await sleep(3_000);
      await shot(mobile, 'player', theme, { mobile: true });
      await mobile.context().close();
      contexts.delete(`carla-${theme}-true`);
    }

    // A voice channel ("Hangout"): six people, five on camera, Eva speaking.
    await speak(bg.diego, false);
    for (const user of ['bruno', 'diego', 'eva', 'felipe'] as const) {
      await inVoice(bg[user], 'hangout', true);
    }
    await inVoice(bg.ana, 'hangout', false);
    await speak(bg.eva, true);
    for (const theme of THEMES) {
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('hangout'));
      await joinVoice(page, true);
      await waitForCameras(page, 5);
      await waitForSpeaking(page, USERS.eva.id);
      await shot(page, 'room-voice', theme);
      await page.context().close();
      contexts.delete(`carla-${theme}-false`);
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('hangout'));
      await joinVoice(mobile, true);
      await waitForCameras(mobile, 4);
      await waitForSpeaking(mobile, USERS.eva.id);
      await shot(mobile, 'room-voice', theme, { mobile: true });
      await mobile.context().close();
      contexts.delete(`carla-${theme}-true`);
    }

    // A text channel ("General"): the page is the chat.
    for (const [who, text] of [
      [bg.bruno, 'Who is up for games on Friday?'],
      [bg.diego, 'Me! I can bring the second controller'],
      [bg.eva, 'Count me in, I will be a bit late'],
      [bg.bruno, 'Great, https://example.com/schedule has the times'],
    ] as const) {
      await who.goto(WEB + roomPath('general'));
      await say(who, text);
    }
    for (const theme of THEMES) {
      const page = await as('carla', theme);
      await page.goto(WEB + roomPath('general'));
      await page.getByTestId('chat-message').first().waitFor();
      await waitForAvatars(page);
      await shot(page, 'room-chat', theme);
      const mobile = await as('carla', theme, true);
      await mobile.goto(WEB + roomPath('general'));
      await mobile.getByTestId('chat-message').first().waitFor();
      await waitForAvatars(mobile);
      await shot(mobile, 'room-chat', theme, { mobile: true });
    }
  } finally {
    await browser.close();
  }
  const total = readdirSync(out).reduce((sum, f) => sum + statSync(join(out, f)).size, 0);
  log(`${readdirSync(out).length} images, ${(total / 1024 / 1024).toFixed(2)} MB in ${out}`);
}

/** Joins the voice of the open room (and, with `camera`, turns the camera on). */
async function joinVoice(page: Page, camera = false): Promise<void> {
  await page.getByRole('button', { name: 'Join voice' }).first().click();
  await page
    .locator('[data-testid^="voice-connected-"][data-phase="joined"]')
    .waitFor({ timeout: 20_000 });
  // The one-time hints ("use headphones", "your microphone is on") out of the way.
  for (const name of ["Don't show again", 'Got it']) {
    const hint = page.getByRole('button', { name, exact: true }).first();
    await hint
      .waitFor({ timeout: 1_500 })
      .then(() => hint.click())
      .catch(() => undefined);
  }
  if (camera) {
    await page.getByTestId('camera-toggle').first().click();
    await page.getByTestId('camera-on-air').first().waitFor({ timeout: 20_000 });
  }
}

/** Opens `slug` in `page` and joins its voice, with the camera on or not. */
async function inVoice(page: Page, slug: string, camera: boolean): Promise<void> {
  await page.goto(`${WEB}/s/friends/r/${slug}`);
  await page.locator('[data-rtc="connected"]').waitFor({ timeout: 30_000 });
  await joinVoice(page, camera);
}

/** Makes the person of `page` audible (a steady tone) or silent, without muting them. */
async function speak(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => (window as unknown as ShotsWindow).__shotsSpeak?.(v), on);
}

/** Sends a chat message in the open room (desktop: the chat panel is open by default). */
async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole('combobox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
  await page.getByTestId('chat-message').filter({ hasText: text }).waitFor();
}

/** Waits until `count` cameras (the own one included) play in the tiles. */
async function waitForCameras(page: Page, count: number): Promise<void> {
  const ok = await page
    .waitForFunction(
      (n) =>
        [...document.querySelectorAll('[data-testid="camera-tile"] video')].filter(
          (v) => (v as HTMLVideoElement).videoWidth > 0,
        ).length >= n,
      count,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) log(`fewer than ${count} cameras play in the tiles`);
  // A moment for the higher camera layers to arrive.
  await sleep(2_500);
}

/** Waits until the speaking ring is on `userId`'s tile. */
async function waitForSpeaking(page: Page, userId: string): Promise<void> {
  const ok = await page
    .locator(`[data-voice-tile="${userId}"][data-speaking="true"]`)
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) log(`no speaking ring on ${userId}`);
}

/** Waits until the profile photos on the page have loaded. */
async function waitForAvatars(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('img[src*="avatar"]')].every(
          (img) => (img as HTMLImageElement).complete,
        ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

interface ShotsWindow {
  __shotsSpeak?: (on: boolean) => void;
}

/**
 * The page's camera and microphone (an init script, so it runs in the browser before the app):
 * getUserMedia answers with a canvas drawing `cam` (a data URL) with a slow zoom and pan, and a
 * tone that stays silent until __shotsSpeak(true). Self-contained: Playwright sends its source.
 */
function fakeMedia(cam: string): void {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (!devices) return;
  const original = devices.getUserMedia.bind(devices);
  const picture = new Image();
  picture.src = cam;
  let audio: { context: AudioContext; gain: GainNode } | null = null;
  let speaking = false;
  (window as unknown as { __shotsSpeak: (on: boolean) => void }).__shotsSpeak = (on) => {
    speaking = on;
    if (audio) audio.gain.gain.value = on ? 0.3 : 0;
    void audio?.context.resume();
  };

  function camera(): MediaStreamTrack {
    const W = 1280;
    const H = 720;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    const t0 = performance.now();
    const draw = () => {
      if (!picture.naturalWidth) {
        g.fillStyle = '#3a3a36';
        g.fillRect(0, 0, W, H);
        return;
      }
      const t = (performance.now() - t0) / 1000;
      const z = 1.09 + 0.03 * Math.sin(t * 0.35);
      const w = W * z;
      const h = H * z;
      g.drawImage(
        picture,
        (W - w) / 2 + Math.sin(t * 0.23) * 14,
        (H - h) / 2 + Math.cos(t * 0.19) * 8,
        w,
        h,
      );
    };
    draw();
    const timer = setInterval(draw, 1000 / 15);
    const [track] = canvas.captureStream(15).getVideoTracks() as [MediaStreamTrack];
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(timer);
      stop();
    };
    return track;
  }

  function microphone(): MediaStreamTrack {
    const context = new AudioContext();
    const tone = context.createOscillator();
    tone.type = 'sawtooth';
    tone.frequency.value = 160;
    const gain = context.createGain();
    gain.gain.value = speaking ? 0.3 : 0;
    const out = context.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    void context.resume();
    audio = { context, gain };
    const [track] = out.stream.getAudioTracks() as [MediaStreamTrack];
    return track;
  }

  devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (!constraints?.video && !constraints?.audio) return original(constraints);
    await picture.decode().catch(() => undefined);
    const tracks: MediaStreamTrack[] = [];
    if (constraints.video) tracks.push(camera());
    if (constraints.audio) tracks.push(microphone());
    return new MediaStream(tracks);
  };
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
