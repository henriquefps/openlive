// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end check that pulling a stream again on the room's one SFU session
// leaves nothing behind that keeps asking for keyframes (helper/README.md "Local end-to-end loop"
// sets up the API and the dev users; run two `test-stream`s with `-v` in the room, one per
// streamer, and point HELPER_LOGS at their logs).
//
// Drives headless Chrome through Vite (:5179) as a DEV_AUTH viewer (the `openlive_dev_user`
// cookie):
//
//   1. Load the room and wait for the pre-connected SFU session.
//   2. Watch the first stream; close and reopen the player OPENS times (5 by default).
//   3. Switch streams: close, watch the second stream, close, watch the first again.
//   4. Keep watching for WINDOW_MS (60 s): count the keyframe requests (RTCP PLI/FIR) each helper
//      logged in that window, the PLIs Chrome says it sent (inbound-rtp `pliCount`), and the
//      live video receivers on the session. One live receiver and ~0 PLIs is the pass.
//
//   ROOM_PATH=/s/dev/r/helper VIEWER=u_view HELPER_LOGS=/tmp/a.log,/tmp/b.log \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [OPENS=5] [WINDOW_MS=60000] [MAX_PLIS=2] node apps/web/e2e/repull-pli.mjs

/* global document, window */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const ROOM_PATH = env('ROOM_PATH');
const VIEWER = env('VIEWER');
const HELPER_LOGS = env('HELPER_LOGS').split(',').filter(Boolean);
const OPENS = Number(env('OPENS', '5'));
const WINDOW_MS = Number(env('WINDOW_MS', '60000'));
const MAX_PLIS = Number(env('MAX_PLIS', '2'));
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok: ${message}`);
}

/** Keyframe requests a helper logged (`-v`) between two wall-clock times. */
function helperRequests(file, from, to) {
  let requests = 0;
  let idrs = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = Date.parse(line.match(/^time=(\S+)/)?.[1] ?? '');
    if (!(at >= from && at < to)) continue;
    if (line.includes('msg="keyframe request"')) requests += 1;
    if (line.includes('msg="forced IDR out of the encoder"')) idrs += 1;
  }
  return { requests, idrs };
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: VIEWER, domain: 'localhost', path: '/' },
  ]);
  // Keep a handle on the room's RTCPeerConnection to read its transceivers and stats.
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__peers = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__peers.push(this);
      }
    };
  });
  const page = await context.newPage();
  const subscribes = [];
  context.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.endsWith('/subscribe') || path.endsWith('/unsubscribe'))
      subscribes.push(path.split('/').pop());
  });
  page.on('pageerror', (e) => log('page error', e.message));

  await page.goto(WEB + ROOM_PATH);
  await page.locator('[data-rtc="connected"]').waitFor({ timeout: 20000 });
  const skip = page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();

  const cards = page.getByRole('button', { name: /^Watch .* stream$/ });
  check((await cards.count()) >= 2, 'two live streams in the room');

  const frames = () =>
    page.evaluate(
      () => document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames,
    );
  const playing = async (label) => {
    await page.locator('[data-ttff-ms]').waitFor({ timeout: 15000 });
    const a = (await frames()) ?? 0;
    await sleep(1500);
    const b = (await frames()) ?? 0;
    check(b > a, `${label}: frames grow (${a} → ${b})`);
  };
  const watch = async (index, label) => {
    await cards.nth(index).click();
    await playing(label);
  };
  const close = async () => {
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-ttff-ms]').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(300);
  };

  await watch(0, 'first watch');
  for (let i = 1; i <= OPENS; i++) {
    await close();
    await watch(0, `reopen ${i}`);
  }
  await close();
  await watch(1, 'switched to the second stream');
  await close();
  await watch(0, 'switched back to the first stream');

  // Let the switch's own keyframe (the join) land before the window opens.
  await sleep(3000);
  const session = () =>
    page.evaluate(async () => {
      const pc = window.__peers.at(-1);
      let pli = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') pli += s.pliCount ?? 0;
      });
      const video = pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video');
      return {
        pli,
        // Stopped ones stay listed while the SFU keeps offering their m-sections.
        videoTransceivers: video.length,
        liveVideoReceivers: video.filter((t) => t.receiver.track.readyState === 'live').length,
      };
    });
  const before = await session();
  const from = Date.now();
  log(`watching for ${WINDOW_MS / 1000} s`, JSON.stringify(before));
  await sleep(WINDOW_MS);
  const to = Date.now();
  const after = await session();
  await playing('still playing after the window');

  const helpers = HELPER_LOGS.map((file) => ({ file, ...helperRequests(file, from, to) }));
  const results = {
    subscribeCalls: subscribes,
    window: { ms: to - from },
    chromePlisSent: after.pli - before.pli,
    session: after,
    helpers,
  };
  console.log(JSON.stringify(results, null, 2));
  const total = helpers.reduce((n, h) => n + h.requests, 0);
  check(
    after.liveVideoReceivers === 1,
    `one live video receiver (got ${after.liveVideoReceivers})`,
  );
  check(
    total <= MAX_PLIS,
    `at most ${MAX_PLIS} keyframe requests at the helpers in the window (got ${total})`,
  );
  log('OK');
} finally {
  await browser.close();
}
