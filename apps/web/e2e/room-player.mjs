// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of the web player through the real Room page (helper/README.md "Local
// end-to-end loop" sets up the API, the dev users and a live `test-stream`).
//
// Drives headless Chrome through Vite (:5179) as DEV_AUTH users (the `openlive_dev_user` cookie,
// which the Vite proxy turns into X-Openlive-Dev-User):
//
//   1. TTFF with pre-connect, RUNS times: load the room, wait until the SFU session is connected
//      (`data-rtc="connected"`), click the stream card, read the player's
//      `data-ttff-ms` (click → first requestVideoFrameCallback), check that frames keep coming,
//      close the watch view and check POST .../unsubscribe and slot.release went out.
//   2. Quality f → q → f through the player's menu: PUT .../layer time and the time until a frame
//      of the new height is presented.
//   3. The queue: the streamer sets the viewer limit to 1, a second viewer gets the "full" screen,
//      joins the queue, gets the offer when the first viewer closes, accepts and plays.
//   4. pagehide: navigating away sends the POST /api/rtc/leave beacon.
//
//   ROOM=rm_… ROOM_PATH=/s/dev/r/helper STREAMER=u_host VIEWER1=u_view1 VIEWER2=u_view2 \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [RUNS=10] [SCREENSHOTS=/some/dir] node apps/web/e2e/room-player.mjs

/* global document */
import { createRequire } from 'node:module';
import path from 'node:path';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const API = env('API', 'http://localhost:8790');
const ROOM = env('ROOM');
const ROOM_PATH = env('ROOM_PATH');
const STREAMER = env('STREAMER');
const VIEWER1 = env('VIEWER1');
const VIEWER2 = env('VIEWER2');
const RUNS = Number(env('RUNS', '10'));
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/** The streamer's own room socket (Node, straight to the API), to set the viewer limit. */
async function streamerSocket() {
  const headers = { 'X-Openlive-Dev-User': STREAMER, Origin: API };
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws/rooms/${ROOM}`, { headers });
  const pending = new Map();
  let next = 0;
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  const request = (type, payload) =>
    new Promise((ok, fail) => {
      const id = String(++next);
      pending.set(id, (msg) =>
        msg.type === 'error' ? fail(new Error(`${type}: ${JSON.stringify(msg.payload)}`)) : ok(msg),
      );
      ws.send(JSON.stringify({ type, id, payload }));
    });
  const welcome = await request('hello', {
    protocol: { major: 1, minor: 1 },
    client: 'web',
    clientVersion: '0.0.0-e2e',
    tabId: 'e2e-streamer',
  });
  return { request, welcome: welcome.payload, close: () => ws.close(1000) };
}

/** A browser context signed in as `userId`, recording rtc requests and room socket frames. */
async function viewer(browser, userId) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: userId, domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();
  const requests = [];
  const sent = [];
  const received = [];
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/rtc/')) {
      requests.push({
        method: r.method(),
        path: url.pathname,
        at: Date.now(),
        done: null,
        request: r,
      });
    }
  });
  context.on('requestfinished', (r) => {
    const entry = requests.find((x) => x.request === r);
    if (entry) entry.done = Date.now();
  });
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => sent.push(String(f.payload)));
    ws.on('framereceived', (f) => received.push({ at: Date.now(), payload: String(f.payload) }));
  });
  page.on('pageerror', (e) => log(userId, 'page error', e.message));
  return { userId, context, page, requests, sent, received };
}

async function openRoom(v) {
  await v.page.goto(WEB + ROOM_PATH);
  const skip = v.page.getByRole('button', { name: "Don't show tutorials again" });
  await v.page.locator('[data-rtc="connected"]').waitFor({ timeout: 20000 });
  // The first visit shows the tutorial, which makes the rest of the page inert.
  if (
    await skip.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
}

const card = (v) => v.page.getByRole('button', { name: /^Watch .* stream$/ }).first();

/** Frames presented so far and the current size, from the real <video>. */
const videoState = (v) =>
  v.page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    return {
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  });

async function framesGrow(v, ms = 1500) {
  const a = await videoState(v);
  await sleep(ms);
  const b = await videoState(v);
  if (!(a && b && b.frames > a.frames)) {
    const screen = await v.page.locator('[role="region"][data-screen]').getAttribute('data-screen');
    const paused = await v.page.evaluate(() => document.querySelector('video')?.paused);
    const subs = v.requests.filter((r) => r.path.endsWith('/subscribe')).length;
    log(
      `${v.userId}: STALL ${a?.frames} → ${b?.frames}, screen ${screen}, paused ${paused}, subscribes ${subs}`,
    );
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const c = await videoState(v);
      if (c.frames > b.frames) {
        log(
          `${v.userId}: recovered after ${(i + 1) * 500} ms, subscribes ${v.requests.filter((r) => r.path.endsWith('/subscribe')).length}`,
        );
        break;
      }
    }
  }
  check(a && b && b.frames > a.frames, `${v.userId}: frames grow (${a?.frames} → ${b?.frames})`);
  return { fps: ((b.frames - a.frames) * 1000) / ms, height: b.height };
}

/** Clicks the card; the player's TTFF plus where the time went, from Node-side timestamps. */
async function watch(v) {
  const before = { requests: v.requests.length, received: v.received.length };
  const clicked = Date.now();
  await card(v).click();
  const player = v.page.locator('[data-ttff-ms]');
  await player.waitFor({ timeout: 15000 });
  const ttff = Number(await player.getAttribute('data-ttff-ms'));
  const granted = v.received
    .slice(before.received)
    .find((f) => f.payload.includes('"slot.granted"'));
  const route = (name) => v.requests.slice(before.requests).find((r) => r.path.endsWith(name));
  const sub = route('/subscribe');
  const reneg = route('/renegotiate');
  const steps = {
    slot: granted ? granted.at - clicked : null,
    subscribe: sub?.done ? sub.done - sub.at : null,
    renegotiate: reneg?.done ? reneg.done - reneg.at : null,
    afterRenegotiate: reneg?.done ? clicked + ttff - reneg.done : null,
  };
  return { ttff, steps };
}

async function closeWatch(v) {
  const before = v.requests.length;
  const sentBefore = v.sent.length;
  await v.page.getByRole('button', { name: 'Close', exact: true }).click();
  const deadline = Date.now() + 5000;
  for (;;) {
    const unsub = v.requests.slice(before).some((r) => r.path.endsWith('/unsubscribe'));
    const release = v.sent.slice(sentBefore).some((f) => f.includes('"slot.release"'));
    if (unsub && release) return;
    check(
      Date.now() < deadline,
      `${v.userId}: close sends unsubscribe (${unsub}) and slot.release (${release})`,
    );
    await sleep(50);
  }
}

async function shot(v, name) {
  if (SCREENSHOTS) await v.page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

/** Picks a quality in the player's menu; resolves with PUT and presented-frame times. */
async function switchQuality(v, label, height) {
  await v.page.locator('[data-slot="player-controls"]').hover();
  await v.page.getByRole('button', { name: 'Quality' }).click();
  const presented = v.page.evaluate(
    (h) =>
      new Promise((resolve, reject) => {
        const video = document.querySelector('video');
        const start = performance.now();
        const timer = setTimeout(() => reject(new Error(`no ${h}p frame`)), 10000);
        const cb = (now, meta) => {
          if (meta.height === h) {
            clearTimeout(timer);
            resolve(Math.round(now - start));
          } else video.requestVideoFrameCallback(cb);
        };
        video.requestVideoFrameCallback(cb);
      }),
    height,
  );
  const before = v.requests.length;
  await v.page.getByRole('menuitemradio', { name: label }).click();
  const frameMs = await presented;
  const put = v.requests.slice(before).find((r) => r.path.endsWith('/layer'));
  const timing = put ? put.request.timing() : null;
  const putMs = timing && timing.responseEnd > 0 ? Math.round(timing.responseEnd) : null;
  return { frameMs, putMs };
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
let streamer;
let streamId;
const results = {};
try {
  streamer = await streamerSocket();
  streamId = streamer.welcome.streams[0]?.streamId;
  check(streamId, 'a live stream in the room (start the helper test-stream first)');
  await streamer.request('stream.setViewerLimit', { streamId, limit: 6 });

  // 1. TTFF with pre-connect.
  const v1 = await viewer(browser, VIEWER1);
  const ttff = [];
  const steps = [];
  for (let run = 1; run <= RUNS; run++) {
    await openRoom(v1);
    if (run === 1) await shot(v1, '1-grid');
    await sleep(500);
    const { ttff: ms, steps: step } = await watch(v1);
    const flow = await framesGrow(v1);
    ttff.push(ms);
    steps.push(step);
    log(
      `run ${run}: TTFF ${ms} ms ${JSON.stringify(step)}, ${flow.fps.toFixed(1)} fps at ${flow.height}p`,
    );
    if (run < RUNS) await closeWatch(v1);
  }
  const stepMedian = (k) => median(steps.map((x) => x[k]).filter((x) => x !== null));
  results.ttff = {
    runs: ttff,
    median: median(ttff),
    worst: Math.max(...ttff),
    best: Math.min(...ttff),
    medianSteps: Object.fromEntries(Object.keys(steps[0]).map((k) => [k, stepMedian(k)])),
  };
  log('TTFF', JSON.stringify(results.ttff));

  // 2. Quality f → q → f, stats for nerds open.
  await v1.page.locator('[data-slot="player-controls"]').hover();
  await v1.page.getByRole('button', { name: 'Stats for nerds (I)' }).click();
  await shot(v1, '2-playing-stats');
  const toQ = await switchQuality(v1, '480p30', 480);
  const q = await framesGrow(v1);
  check(q.height === 480, `q layer is 480p (got ${q.height})`);
  await shot(v1, '3-quality-q');
  const toF = await switchQuality(v1, '1080p60', 1080);
  const f = await framesGrow(v1);
  check(f.height === 1080, `f layer is 1080p (got ${f.height})`);
  results.layers = { 'f→q': toQ, 'q→f': toF };
  log('layer switches', JSON.stringify(results.layers));

  // 3. Queue: limit 1, viewer 2 gets the full screen, joins, gets the offer when viewer 1 leaves.
  await streamer.request('stream.setViewerLimit', { streamId, limit: 1 });
  const v2 = await viewer(browser, VIEWER2);
  await openRoom(v2);
  await card(v2).click();
  await v2.page.locator('[role="region"][data-screen="full"]').waitFor({ timeout: 10000 });
  await v2.page.getByRole('button', { name: 'Join the queue' }).click();
  await v2.page.getByText('You are number 1 of 1 in line').waitFor({ timeout: 10000 });
  await shot(v2, '4-queue');
  const left = Date.now();
  await closeWatch(v1);
  await v2.page.getByRole('button', { name: 'Watch now' }).waitFor({ timeout: 10000 });
  const offerMs = Date.now() - left;
  await shot(v2, '5-offer');
  const accepted = Date.now();
  await v2.page.getByRole('button', { name: 'Watch now' }).click();
  await v2.page.locator('[data-ttff-ms]').waitFor({ timeout: 15000 });
  const acceptToFrameMs = Date.now() - accepted;
  await framesGrow(v2);
  await shot(v2, '6-viewer2-playing');
  results.queue = { offerAfterLeaveMs: offerMs, acceptToFrameMs };
  log('queue', JSON.stringify(results.queue));

  // 4. pagehide → beacon.
  const before = v2.requests.length;
  await v2.page.goto('about:blank');
  await sleep(1000);
  const beacon = v2.requests.slice(before).some((r) => r.path === '/api/rtc/leave');
  check(beacon, 'pagehide sends POST /api/rtc/leave');
  results.beacon = beacon;

  console.log(JSON.stringify(results, null, 2));
  log('OK');
} finally {
  if (streamer && streamId) {
    await streamer.request('stream.setViewerLimit', { streamId, limit: 6 }).catch(() => undefined);
  }
  streamer?.close();
  await browser.close();
}
