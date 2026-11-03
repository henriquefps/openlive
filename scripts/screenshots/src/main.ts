// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm screenshots`: the README gallery (docs/img/screens/), taken from the real web app against
// a local instance with fictional data. See scripts/screenshots/README.md.

import { join, resolve } from 'node:path';
import { loadAssets } from './assets.ts';
import { capture } from './capture.ts';
import { buildHelper, pairHelper, runHelper, testStream } from './helpers.ts';
import { seed } from './seed.ts';
import { log, startStack, stopAll, tempDir } from './stack.ts';

const repo = resolve(import.meta.dirname, '../../..');
const out = process.env['OUT'] ?? join(repo, 'docs', 'img', 'screens');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

/** The screen Ana's helper offers in Go live. */
const GO_LIVE_SOURCE = 'Entire screen';

const assets = await loadAssets();
const stack = await startStack(repo);
try {
  const seeded = await seed(stack, assets);
  log('seeded', seeded);
  if (stack.live) {
    const bin = buildHelper(repo, tempDir('bin'));
    // Bruno streams the movie into "Movie night" from the start; Ana's helper waits for "Go
    // live" with the game, which she starts in "Games".
    const bruno = await pairHelper(bin, 'bruno', 'bruno-desktop');
    testStream(bruno, seeded.rooms.movies, '1080p60', assets.stream.movie, GO_LIVE_SOURCE);
    runHelper(await pairHelper(bin, 'ana', 'ana-desktop'), assets.stream.game, GO_LIVE_SOURCE);
  }
  await capture({ out, live: stack.live, assets, goLiveSource: GO_LIVE_SOURCE });
  if (assets.provisional.length) {
    log(`made with PROVISIONAL stand-ins: ${assets.provisional.join(', ')}`);
  }
  if (process.env['SERVE']) {
    log('SERVE is set: the stack stays up until Ctrl+C');
    await new Promise(() => undefined);
  }
} finally {
  stack.cleanup();
}
