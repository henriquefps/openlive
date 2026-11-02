// SPDX-License-Identifier: AGPL-3.0-only
// TTFF with and without pull on hover (rtc/prepull.ts), through the real
// Room page. Same setup as room-player.mjs (helper/README.md "Local end-to-end loop": the API,
// the dev users and a live `test-stream`).
//
// For each mode, RUNS times on a fresh page (session connected before anything):
//   click    `?flags=noprepull`: click the card, read the player's `data-ttff-ms`.
//   prepull  `?flags=prepull`: rest the pointer on the card for HOVER_MS, then click.
// Each run checks that frames keep coming and that closing sends unsubscribe + slot.release; a
// prepull run also checks that the hover pulled the q layer and the click switched up with one
// PUT .../layer and no second subscribe. Then the egress of an abandoned hover: the bytes the
// page received while hovering, and that the pull and the slot are released after the hold.
//
//   ROOM_PATH=/s/dev/r/helper VIEWER=u_view1 \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [WEB=http://localhost:5179] [RUNS=20] [HOVER_MS=800] node apps/web/e2e/prepull-ttff.mjs

/* global document, window */
import { createRequire } from 'node:module';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const ROOM_PATH = env('ROOM_PATH');
const VIEWER = env('VIEWER');
const RUNS = Number(env('RUNS', '20'));
const HOVER_MS = Number(env('HOVER_MS', '800'));
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return Math.round(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo));
};
const summary = (xs) => ({
  n: xs.length,
  median: quantile(xs, 0.5),
  p90: quantile(xs, 0.9),
  worst: Math.max(...xs),
  best: Math.min(...xs),
});
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function newViewer(browser) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: VIEWER, domain: 'localhost', path: '/' },
    // No tutorial: it makes the page inert.
  ]);
  // Keep the page's peer connections reachable, to read the bytes received while hovering.
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
  });
  const page = await context.newPage();
  const requests = [];
  const sent = [];
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: r.method(), path: url.pathname, body: r.postData(), at: Date.now() });
    }
  });
  page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
  page.on('pageerror', (e) => log('page error', e.message));
  return { context, page, requests, sent };
}

async function openRoom(v, flags) {
  await v.page.goto(`${WEB}${ROOM_PATH}?flags=${flags}`);
  await v.page.locator('[data-rtc="connected"]').waitFor({ timeout: 20000 });
  const skip = v.page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 1000 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
}

const card = (v) => v.page.getByRole('button', { name: /^Watch .* stream$/ }).first();
const cardItem = (v) => v.page.locator('li:has(button[aria-label^="Watch "])').first();

const bytesReceived = (v) =>
  v.page.evaluate(async () => {
    let total = 0;
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp') total += s.bytesReceived ?? 0;
      });
    }
    return total;
  });

const frames = (v) =>
  v.page.evaluate(
    () => document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
  );

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
      `close sends unsubscribe (${unsub}) and slot.release (${release})`,
    );
    await sleep(50);
  }
}

async function run(browser, mode, i) {
  const v = await newViewer(browser);
  try {
    await openRoom(v, mode === 'prepull' ? 'prepull' : 'noprepull');
    await sleep(300);
    let hoverBytes = null;
    if (mode === 'prepull') {
      const b0 = await bytesReceived(v);
      await cardItem(v).hover();
      await sleep(HOVER_MS);
      hoverBytes = (await bytesReceived(v)) - b0;
    }
    const before = v.requests.length;
    await card(v).click();
    const player = v.page.locator('[data-ttff-ms]');
    await player.waitFor({ timeout: 15000 });
    const ttff = Number(await player.getAttribute('data-ttff-ms'));
    const f0 = await frames(v);
    await sleep(1500);
    const f1 = await frames(v);
    check(f1 > f0, `${mode} #${i}: frames grow (${f0} → ${f1})`);
    const after = v.requests.slice(before);
    const subscribes = after.filter((r) => r.path.endsWith('/subscribe')).length;
    const layers = after
      .filter((r) => r.path.endsWith('/layer'))
      .map((r) => JSON.parse(r.body).rid);
    if (mode === 'prepull') {
      const pulledQ = v.requests
        .slice(0, before)
        .some((r) => r.path.endsWith('/subscribe') && JSON.parse(r.body).rid === 'q');
      check(pulledQ, `prepull #${i}: the hover pulled the q layer`);
      check(subscribes === 0, `prepull #${i}: no second subscribe after the click (${subscribes})`);
      check(layers[0] === 'f', `prepull #${i}: switched up to f with PUT .../layer (${layers})`);
    }
    const height = await v.page.evaluate(() => document.querySelector('video')?.videoHeight);
    await closeWatch(v);
    log(
      `${mode} #${i}: ttff ${ttff} ms, height after 1.5 s ${height}, hover bytes ${hoverBytes ?? '-'}`,
    );
    return { ttff, hoverBytes };
  } finally {
    await v.context.close();
  }
}

/** Hover, leave without clicking: what it cost, and that it is all given back. */
async function abandoned(browser, holdMs) {
  const v = await newViewer(browser);
  try {
    await openRoom(v, 'prepull');
    await sleep(300);
    const b0 = await bytesReceived(v);
    const start = Date.now();
    await cardItem(v).hover();
    await sleep(HOVER_MS);
    await v.page.mouse.move(5, 5);
    const left = Date.now();
    const deadline = left + holdMs + 5000;
    let released = null;
    for (;;) {
      const unsub = v.requests.some((r) => r.path.endsWith('/unsubscribe'));
      const release = v.sent.some((f) => f.includes('"slot.release"'));
      if (unsub && release) {
        released = Date.now() - left;
        break;
      }
      check(
        Date.now() < deadline,
        `abandoned hover is released (unsub ${unsub}, release ${release})`,
      );
      await sleep(100);
    }
    const bytes = (await bytesReceived(v)) - b0;
    const metrics = v.requests.filter((r) => r.path === '/api/metrics/viewer').length;
    log(
      `abandoned hover: ${HOVER_MS} ms on the card, released ${released} ms after leaving, ` +
        `${(bytes / 1e6).toFixed(2)} MB received in ${Date.now() - start} ms, metrics posts ${metrics}`,
    );
    return { releasedMs: released, bytes, ms: Date.now() - start };
  } finally {
    await v.context.close();
  }
}

/** One watch long enough for a metrics window (30 s): the post goes out with the right body. */
async function metricsPost(browser) {
  const v = await newViewer(browser);
  try {
    await openRoom(v, 'prepull');
    await cardItem(v).hover();
    await sleep(HOVER_MS);
    await card(v).click();
    await v.page.locator('[data-ttff-ms]').waitFor({ timeout: 15000 });
    await sleep(31_000);
    await closeWatch(v);
    await sleep(500);
    const posts = v.requests
      .filter((r) => r.path === '/api/metrics/viewer')
      .map((r) => JSON.parse(r.body));
    check(posts.length >= 2, `a window post and a closing post (${posts.length})`);
    check(posts[0].start === 'prepull' && posts[0].ttffMs >= 0, 'the first post carries the TTFF');
    log('metrics posts:', JSON.stringify(posts));
    return posts;
  } finally {
    await v.context.close();
  }
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const results = { click: [], prepull: [], hoverBytes: [] };
  // Interleaved, so both modes see the same network and SFU conditions.
  for (let i = 1; i <= RUNS; i++) {
    results.click.push((await run(browser, 'click', i)).ttff);
    const p = await run(browser, 'prepull', i);
    results.prepull.push(p.ttff);
    results.hoverBytes.push(p.hoverBytes);
  }
  const gone = await abandoned(browser, 5000);
  const posts = await metricsPost(browser);
  console.log(
    JSON.stringify(
      {
        hoverMs: HOVER_MS,
        click: summary(results.click),
        prepull: summary(results.prepull),
        hoverMB: summary(results.hoverBytes.map((b) => b / 1e6)),
        abandoned: gone,
        metricsPosts: posts.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
