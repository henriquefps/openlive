// SPDX-License-Identifier: AGPL-3.0-only
// Loads the schema files and builds the Ajv instance. Shared by the generator and the tests,
// so the runtime validators and the strict contract checks use the same options.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemas are arbitrary JSON
export type Schema = Record<string, any>;

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaDir = join(packageRoot, 'schema');

function readJson(path: string): Schema {
  return JSON.parse(readFileSync(path, 'utf8')) as Schema;
}

/** common.json, codes.json, envelope.json, rest.json, in that order. */
export const sharedSchemas: Schema[] = [
  'common.json',
  'codes.json',
  'envelope.json',
  'rest.json',
].map((f) => readJson(join(schemaDir, f)));

/** One file per message type, sorted by file name. */
export const messageSchemas: { file: string; schema: Schema }[] = readdirSync(
  join(schemaDir, 'messages'),
)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: `messages/${f}`, schema: readJson(join(schemaDir, 'messages', f)) }));

export const allSchemas: Schema[] = [...sharedSchemas, ...messageSchemas.map((m) => m.schema)];

/**
 * strict: unknown properties are errors (contract tests).
 * lenient: unknown properties are removed before validation of the rest (receivers).
 */
export function createAjv(mode: 'strict' | 'lenient', standalone = false): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    // hello uses if/then to require deviceId for helpers; the property is declared on the parent.
    strictRequired: false,
    allErrors: false,
    inlineRefs: false,
    removeAdditional: mode === 'lenient',
    keywords: ['x-openlive', 'x-enumNames'],
    code: standalone ? { source: true, esm: true, lines: true } : {},
  });
  for (const s of allSchemas) ajv.addSchema(s);
  return ajv;
}
