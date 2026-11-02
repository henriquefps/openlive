// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end run of the text chat through the real Room
// page: two browser contexts, two users, the real room socket and RoomDO.
//
//   1. A sends a message with a mention, a link and markup; B receives it: the mention is
//      highlighted, the link opens safely (target=_blank, rel=noopener noreferrer) and the markup
//      stays text.
//   2. B answers with the @ autocomplete; A receives it.
//   3. A edits its message: B sees the new text and "(edited)".
//   4. A deletes its message: it leaves B's list.
//   5. History: B reloads and gets the remaining messages from chat.history.
//   6. Unread: B goes to the space page, A writes again, and B's room list shows the badge.
//   7. A room with stream and text shows the chat as a panel beside the streams.
//
// No SFU or helper needed. The API with the dev identity only (no Realtime credentials), and Vite
// pointed at it, on ports of your choice:
//
//   (cd apps/api && pnpm db:migrate:local && npx wrangler dev --port 8800 \
//     --local-upstream localhost:5190 --upstream-protocol http \
//     --var DEV_AUTH:1 --var SESSION_SECRET:$(openssl rand -hex 32))
//   (cd apps/web && OPENLIVE_API=http://localhost:8800 npx vite --port 5190)
//
// with two users who are members of a space that has a text-only room and a "watch together"
// room (see helper/README.md "Local end-to-end loop" for creating them), then:
//
//   WEB=http://localhost:5190 SPACE_PATH=/s/chat TEXT_ROOM=talk WATCH_ROOM=watch \
//   USER_A=u_ana NAME_A=Ana USER_B=u_bia NAME_B=Bia \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   [SCREENSHOTS=/some/dir] node apps/web/e2e/chat.mjs

import { createRequire } from 'node:module';
import path from 'node:path';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const WEB = env('WEB', 'http://localhost:5179');
const SPACE_PATH = env('SPACE_PATH');
const TEXT_ROOM = env('TEXT_ROOM');
const WATCH_ROOM = env('WATCH_ROOM');
const USER_A = env('USER_A');
const USER_B = env('USER_B');
const NAME_A = env('NAME_A');
const NAME_B = env('NAME_B');
const SCREENSHOTS = process.env.SCREENSHOTS ?? null;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok:', message);
}

async function skipTutorial(page) {
  // The first visit shows the tutorial, which makes the rest of the page inert.
  const skip = page.getByRole('button', { name: "Don't show tutorials again" });
  if (
    await skip.waitFor({ timeout: 4_000 }).then(
      () => true,
      () => false,
    )
  )
    await skip.click();
}

async function person(browser, userId) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: 'openlive_dev_user', value: userId, domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (e) => log(userId, 'page error', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') log(userId, 'console error', m.text());
  });
  return { userId, context, page };
}

async function openRoom(p, slug) {
  await p.page.goto(`${WEB}${SPACE_PATH}/r/${slug}`);
  await skipTutorial(p.page);
}

const composer = (page) => page.getByRole('combobox', { name: 'Message' });
const messageWith = (page, text) =>
  page.locator('[data-testid="chat-message"]').filter({ hasText: text });

async function shot(page, name) {
  if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

const browser = await chromium.launch({
  executablePath: env('CHROME', '/usr/bin/google-chrome-stable'),
  headless: true,
});
try {
  const a = await person(browser, USER_A);
  const b = await person(browser, USER_B);
  await openRoom(a, TEXT_ROOM);
  await openRoom(b, TEXT_ROOM);
  await a.page.getByTestId('chat-page').waitFor();
  await b.page.getByTestId('chat-page').waitFor();
  check(true, 'both see the text channel as a chat page');

  // 1. Send with a mention, a link and markup.
  const stamp = Date.now().toString(36);
  const first = `hello @${NAME_B} see https://example.com/${stamp}. <b>bold?</b>`;
  await composer(a.page).fill(first);
  // The @ autocomplete opened while typing would take Enter; fill() does not open it.
  await composer(a.page).press('Enter');
  const received = messageWith(b.page, `example.com/${stamp}`);
  await received.waitFor({ timeout: 10_000 });
  check(true, 'B receives A’s message');
  const link = received.getByRole('link');
  check((await link.getAttribute('href')) === `https://example.com/${stamp}`, 'the link href');
  check((await link.getAttribute('target')) === '_blank', 'the link opens in a new tab');
  check(((await link.getAttribute('rel')) ?? '').includes('noopener'), 'the link has rel=noopener');
  check((await received.locator('b').count()) === 0, 'markup stays text');
  check((await received.getByText('<b>bold?</b>').count()) === 1, 'the markup is shown as text');
  check(
    (await received.locator('span', { hasText: `@${NAME_B}` }).count()) > 0,
    'the mention is highlighted',
  );
  await shot(b.page, 'chat-received');

  // 2. B answers through the @ autocomplete.
  await composer(b.page).click();
  await composer(b.page).pressSequentially(`hi @${NAME_A.slice(0, 2)}`);
  const option = b.page.getByRole('option', { name: NAME_A });
  await option.waitFor();
  await composer(b.page).press('Enter');
  check((await composer(b.page).inputValue()) === `hi @${NAME_A} `, 'the autocomplete inserts');
  await composer(b.page).pressSequentially(`back ${stamp}`);
  await composer(b.page).press('Enter');
  await messageWith(a.page, `back ${stamp}`).waitFor({ timeout: 10_000 });
  check(true, 'A receives B’s answer');

  // 3. A edits its message.
  const own = messageWith(a.page, `example.com/${stamp}`);
  await own.hover();
  await own.getByRole('button', { name: /Message actions/ }).click();
  await a.page.getByRole('menuitem', { name: 'Edit' }).click();
  const box = a.page.getByRole('textbox', { name: 'Edit message' });
  await box.fill(`edited ${stamp}`);
  await box.press('Enter');
  const edited = messageWith(b.page, `edited ${stamp}`);
  await edited.waitFor({ timeout: 10_000 });
  check((await edited.getByText('(edited)').count()) === 1, 'B sees the edit');

  // 4. A deletes it.
  const mine = messageWith(a.page, `edited ${stamp}`);
  await mine.hover();
  await mine.getByRole('button', { name: /Message actions/ }).click();
  await a.page.getByRole('menuitem', { name: 'Delete' }).click();
  await a.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await messageWith(b.page, `edited ${stamp}`).waitFor({ state: 'detached', timeout: 10_000 });
  check(true, 'the deleted message leaves B’s list');

  // 5. History after a reload.
  await b.page.reload();
  await skipTutorial(b.page);
  await messageWith(b.page, `back ${stamp}`).waitFor({ timeout: 10_000 });
  check(
    (await messageWith(b.page, `edited ${stamp}`).count()) === 0,
    'history has the answer and not the deleted message',
  );

  // 6. Unread on the space's room list.
  await b.page.goto(`${WEB}${SPACE_PATH}`);
  await skipTutorial(b.page);
  await composer(a.page).fill(`are you there ${stamp}`);
  await composer(a.page).press('Enter');
  await messageWith(a.page, `are you there ${stamp}`).waitFor();
  await b.page.reload();
  await skipTutorial(b.page);
  const badge = b.page.getByTestId('room-unread');
  await badge.waitFor({ timeout: 10_000 });
  check(
    Number(await badge.innerText()) >= 1,
    `B's room list shows ${await badge.innerText()} unread`,
  );
  await shot(b.page, 'chat-unread');

  // 7. Stream and text: the chat is a panel beside the streams.
  await openRoom(a, WATCH_ROOM);
  await a.page.getByTestId('chat-panel').waitFor({ timeout: 10_000 });
  check(true, 'a watch-together room shows the chat panel');
  await shot(a.page, 'chat-panel');
  log('PASS');
} finally {
  await browser.close();
}
