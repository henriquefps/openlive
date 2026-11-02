// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of cameras in the voice channel through the
// real Room page: two browser contexts with Chrome's fake microphone and camera, in a room with the
// camera capability, against the real SFU proxy routes and the dev Realtime app.
//
//   1. Both join voice. A turns the camera on (POST .../camera/publish, two simulcast layers) and
//      sees "You're on camera"; everyone sees A's camera icon.
//   2. B's strip pulls A's camera (POST .../camera/subscribe) on the low layer: the inbound video
//      decodes at 180 lines, and A's microphone is in the camera's msid stream (lip sync).
//   3. B enlarges A's camera: PUT .../camera/layer to h, the decoded video reaches 360 lines; closing
//      it goes back to 180.
//   4. A turns the camera off (POST .../camera/unpublish): B's tile shows the avatar again.
//
// Setup as in helper/README.md "Local end-to-end loop" (API with DEV_AUTH, Vite), with two users
// who are members of the room's space and a room with { stream, voice, camera } (no helper needed):
//
//   ROOM_PATH=/s/cam/r/watch USER_A=u_ana USER_B=u_bia [WEB=http://localhost:5191] \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/camera.mjs

/* global window */
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

/** Received camera video: decoded frames and the largest frame height of the live inbound tracks. */
async function inboundVideo(page) {
  return page.evaluate(async () => {
    let frames = 0;
    let height = 0;
    let tracks = 0;
    for (const pc of window.__peers) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video' && (s.framesDecoded ?? 0) > 0) {
          tracks += 1;
          frames += s.framesDecoded ?? 0;
          height = Math.max(height, s.frameHeight ?? 0);
        }
      });
    }
    return { frames, height, tracks };
  });
}

/** Sent camera layers: the outbound video encodings with their rid and frame height. */
async function outboundVideo(page) {
  return page.evaluate(async () => {
    const layers = [];
    for (const pc of window.__peers) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          layers.push({ rid: s.rid ?? null, height: s.frameHeight ?? 0, kbps: s.targetBitrate });
        }
      });
    }
    return layers;
  });
}

/** Whether the remote SDP puts an audio m-section in the msid stream of a video one. */
async function lipSynced(page) {
  return page.evaluate(() =>
    window.__peers.some((pc) => {
      const sdp = pc.remoteDescription?.sdp ?? '';
      const sections = sdp.split(/\r?\n(?=m=)/).slice(1);
      const streamOf = (s) => /a=msid:(\S+)/.exec(s)?.[1] ?? null;
      const videos = new Set(
        sections
          .filter((s) => s.startsWith('m=video'))
          .map(streamOf)
          .filter(Boolean),
      );
      return sections.some((s) => s.startsWith('m=audio') && videos.has(streamOf(s)));
    }),
  );
}

async function person(browser, userId) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    permissions: ['microphone', 'camera'],
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: userId, domain: 'localhost', path: '/' },
  ]);
  await context.addInitScript(recordPeers);
  const page = await context.newPage();
  const requests = [];
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/rtc/') && url.pathname.includes('/camera/')) {
      const body = r.postData() ?? '';
      const rid = /"rid":"(\w+)"/.exec(body)?.[1];
      requests.push(
        `${r.method()} ${url.pathname.replace(/^\/api\/rtc\/rooms\/[^/]+/, '')}${rid ? ` ${rid}` : ''}`,
      );
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

async function waitFor(fn, message, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`FAILED (timeout): ${message}`);
    await sleep(250);
  }
}

async function shot(p, name) {
  if (!SCREENSHOTS) return;
  await p.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

const tile = (page, userId) => page.locator(`[data-testid="camera-tile"][data-user="${userId}"]`);

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

  // 1. Both join voice; A turns the camera on.
  for (const p of [a, b]) {
    const join = p.page.getByRole('button', { name: 'Join voice' }).first();
    await join.waitFor();
    await waitFor(() => join.isEnabled(), `${p.userId}: Join voice enabled`);
    await join.click();
    await p.page.getByRole('toolbar', { name: 'Voice controls' }).first().waitFor();
  }
  check(true, 'both in voice');
  const toggle = a.page.getByTestId('camera-toggle').first();
  await waitFor(() => toggle.isEnabled(), `${USER_A}: camera toggle enabled`);
  const t0 = Date.now();
  await toggle.click();
  await a.page.getByTestId('camera-on-air').first().waitFor();
  log(USER_A, `on camera after ${Date.now() - t0} ms`);
  check(
    a.requests.includes('POST /camera/publish'),
    `${USER_A} published (POST .../camera/publish)`,
  );
  await waitFor(
    async () => (await outboundVideo(a.page)).filter((l) => l.rid).length === 2,
    `${USER_A} sends two simulcast layers`,
  );
  const sent = await outboundVideo(a.page);
  log(USER_A, 'sent layers', JSON.stringify(sent));
  check(
    sent.some((l) => l.rid === 'h') && sent.some((l) => l.rid === 'l'),
    `${USER_A} sends layers h and l`,
  );
  await b.page
    .locator('[data-testid="in-voice"]')
    .getByRole('img', { name: 'Camera on' })
    .waitFor();
  check(true, `${USER_B} sees ${USER_A}'s camera icon`);

  // 2. B's strip pulls A's camera on the low layer, in sync with A's voice.
  await tile(b.page, USER_A).locator('video').waitFor();
  check(
    b.requests.includes('POST /camera/subscribe'),
    `${USER_B} pulled (POST .../camera/subscribe)`,
  );
  await waitFor(async () => {
    const v = await inboundVideo(b.page);
    return v.frames > 10 && v.height > 0 && v.height <= 180;
  }, `${USER_B} decodes ${USER_A}'s camera on the low layer`);
  const strip = await inboundVideo(b.page);
  log(USER_B, 'strip', JSON.stringify(strip));
  check(strip.height === 180, `${USER_B}'s strip shows 180 lines (low layer)`);
  await waitFor(() => lipSynced(b.page), `${USER_A}'s voice joins the camera's msid stream`);
  check(true, `${USER_B}: ${USER_A}'s microphone and camera share one msid stream (lip sync)`);
  await shot(a, 'camera-a-on');
  await shot(b, 'camera-b-strip');

  // 3. Enlarge: the high layer; close: back to the low one.
  await tile(b.page, USER_A).getByRole('button').click();
  await b.page.getByTestId('camera-enlarged').waitFor();
  await waitFor(
    () => b.requests.includes('PUT /camera/layer h'),
    `${USER_B} switched to h (PUT .../camera/layer)`,
  );
  check(true, `${USER_B} asked for the high layer`);
  await waitFor(
    async () => (await inboundVideo(b.page)).height >= 360,
    `${USER_B} decodes 360 lines while enlarged`,
  );
  check(true, `${USER_B}'s enlarged camera shows 360 lines (high layer)`);
  await shot(b, 'camera-b-enlarged');
  await b.page.getByRole('button', { name: 'Close the enlarged camera' }).click();
  await waitFor(() => b.requests.includes('PUT /camera/layer l'), `${USER_B} switched back to l`);
  await waitFor(
    async () => (await inboundVideo(b.page)).height === 180,
    `${USER_B} back on 180 lines`,
  );
  check(true, `${USER_B} is back on the low layer after closing`);

  // 4. A turns the camera off: B shows the avatar again.
  await toggle.click();
  await waitFor(() => a.requests.includes('POST /camera/unpublish'), `${USER_A} unpublished`);
  check(true, `${USER_A} turned the camera off (POST .../camera/unpublish)`);
  await waitFor(
    async () =>
      (await b.page.getByTestId('camera-strip').count()) === 0 ||
      (await tile(b.page, USER_A).locator('video').count()) === 0,
    `${USER_B} no longer shows ${USER_A}'s camera`,
  );
  check(true, `${USER_B} no longer shows ${USER_A}'s camera`);
  log('requests', USER_A, a.requests.join(', '));
  log('requests', USER_B, b.requests.join(', '));
  log('PASS');
} catch (error) {
  if (SCREENSHOTS) {
    for (const [i, context] of browser.contexts().entries()) {
      await context
        .pages()[0]
        ?.screenshot({ path: path.join(SCREENSHOTS, `camera-failed-${i}.png`) })
        .catch(() => undefined);
    }
  }
  throw error;
} finally {
  await browser.close();
}
