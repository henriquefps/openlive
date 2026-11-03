// SPDX-License-Identifier: AGPL-3.0-only
// CI check: every locale has exactly the keys of `en`, and every protocol error code
// has a translation. Exits non-zero with the list of problems.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REFERENCE = 'en';
const localesDir = fileURLToPath(new URL('../locales/', import.meta.url));

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

function loadLocale(locale: string): Map<string, string> {
  const files = readdirSync(`${localesDir}/${locale}`).filter((f) => f.endsWith('.json'));
  const keys = new Map<string, string>();
  for (const file of files) {
    const namespace = file.replace(/\.json$/, '');
    const tree = JSON.parse(readFileSync(`${localesDir}/${locale}/${file}`, 'utf8')) as Tree;
    for (const [key, value] of flatten(tree)) keys.set(`${namespace}:${key}`, value);
  }
  return keys;
}

const require = createRequire(import.meta.url);
const codes = require('@openlive/protocol/schema/codes.json') as {
  $defs: { ErrorCode: { enum: string[] } };
};
const errorCodes = codes.$defs.ErrorCode.enum;

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const reference = loadLocale(REFERENCE);
const problems: string[] = [];

for (const locale of locales) {
  const keys = loadLocale(locale);
  for (const key of reference.keys()) {
    if (!keys.has(key)) problems.push(`${locale}: missing key ${key}`);
  }
  for (const [key, value] of keys) {
    if (!reference.has(key)) problems.push(`${locale}: extra key ${key} (not in ${REFERENCE})`);
    else if (value.trim() === '') problems.push(`${locale}: empty value for ${key}`);
  }
  for (const code of errorCodes) {
    if (!keys.has(`translation:errors.${code}`)) {
      problems.push(`${locale}: no translation for protocol error code ${code}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `i18n check passed: ${locales.join(', ')} have the same ${reference.size} keys, ` +
    `including all ${errorCodes.length} protocol error codes.`,
);
