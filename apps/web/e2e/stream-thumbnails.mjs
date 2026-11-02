// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end check of stream thumbnails on the room's cards:
// a helper streams in the room (`openlive-helper test-stream`, helper/README.md "Local
// end-to-end loop"), and a viewer who never opens the player sees the card's snapshot load and
// refresh about every 10 s, served by the Worker (private, versioned URL), with no viewer slot.
//
//   WEB=http://localhost:5179 ROOM_PATH=/s/dev/r/helper VIEWER=u_view \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/stream-thumbnails.mjs

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
const VIEWER = env('VIEWER');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok: ${message}`);
}

const browser = await chromium.launch({ executablePath: env('CHROME', undefined), headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'openlive_dev_user', value: VIEWER, url: WEB }]);
  const page = await context.newPage();
  const served = [];
  page.on('response', (res) => {
    if (/\/api\/streams\/[^/]+\/thumbnail/.test(res.url())) {
      served.push({
        url: res.url(),
        status: res.status(),
        cache: res.headers()['cache-control'],
        type: res.headers()['content-type'],
      });
    }
  });
  const slotRequests = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (String(f.payload).includes('"slot.request"')) slotRequests.push(f.payload);
    });
  });
  await page.goto(`${WEB}${ROOM_PATH}`);

  // The card's image: src carries ?v=<thumbnailAt>, and it decodes as a 320 px JPEG.
  const card = async () =>
    page.evaluate(() => {
      const img = document.querySelector('[data-status] img');
      return img ? { src: img.getAttribute('src'), width: img.naturalWidth } : null;
    });
  await page.waitForFunction(
    () => document.querySelector('[data-status] img')?.naturalWidth > 0,
    null,
    {
      timeout: 30_000,
    },
  );
  const first = await card();
  log('card thumbnail', first);
  check(
    /\/api\/streams\/[^/]+\/thumbnail\?v=\d+$/.test(first.src),
    'the card shows a versioned thumbnail URL',
  );
  check(first.width === 320, 'the thumbnail is 320 px wide');
  if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, 'thumbnail-1.png') });

  // It refreshes: a new version within ~10 s (stream.updated), and the new image loads.
  await page.waitForFunction(
    (src) => {
      const img = document.querySelector('[data-status] img');
      return img && img.getAttribute('src') !== src && img.complete && img.naturalWidth > 0;
    },
    first.src,
    { timeout: 25_000 },
  );
  const second = await card();
  const v = (src) => Number(new URL(src, WEB).searchParams.get('v'));
  log('card thumbnail', second, `after ${((v(second.src) - v(first.src)) / 1000).toFixed(1)} s`);
  check(v(second.src) > v(first.src), 'the card refreshed to a newer thumbnail');
  if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, 'thumbnail-2.png') });

  const ok = served.filter((s) => s.status === 200);
  check(ok.length >= 2, `the Worker served ${ok.length} thumbnails`);
  check(
    ok.every((s) => s.cache === 'private, max-age=10' && s.type === 'image/jpeg'),
    'served as private JPEGs (Cache-Control: private, max-age=10)',
  );
  check(slotRequests.length === 0, 'viewing the thumbnails took no viewer slot');
  log('PASS');
} finally {
  await browser.close();
}
