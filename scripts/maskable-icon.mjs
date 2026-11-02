// SPDX-License-Identifier: AGPL-3.0-only
// The PWA's maskable icon (apps/web/public/icon-maskable-512.png): a full-bleed olive square with
// the glyph inside the 80% safe zone, which build-icons.mjs (hfps-repo-assets) does not make.
//
//   SHARP=<folder>/node_modules/sharp node scripts/maskable-icon.mjs scripts/glyph.svg \
//     apps/web/public/icon-maskable-512.png
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)(process.env.SHARP);
const glyph = (await readFile(process.argv[2], 'utf8'))
  .replace(/<!--[\s\S]*?-->/g, '')
  .replaceAll('currentColor', '#fff');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512"><rect width="128" height="128" fill="#5b7a3a"/><g transform="translate(29 29) scale(0.7)">${glyph}</g></svg>`;
await writeFile(
  process.argv[3],
  await sharp(Buffer.from(svg), { density: 288 }).resize(512, 512).png().toBuffer(),
);
