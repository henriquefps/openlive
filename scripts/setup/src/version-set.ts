// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm run version:set <x.y.z>`: the project version is the root package.json's "version".
// apps/api and apps/web (and the packages under packages/) carry a copy, because the Worker
// answers it on /api/health and the Vite build bundles its own; this bumps them all together.
// A test fails when a copy drifts. The Go helper is not touched: it gets VERSION at build
// (`pnpm run helper:publish`, which defaults to this version when there is no helper-v* tag).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+$/;

export const validVersion = (v: string): boolean => SEMVER.test(v);

/** The package.json files that carry the project version, relative to the repository root. */
export function versionedPackages(root: string): string[] {
  const dirs = ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(group, e.name)),
  );
  return ['package.json', ...dirs.map((d) => join(d, 'package.json'))];
}

/** Replaces the top-level "version" in a package.json text, keeping its formatting. */
export function withVersion(text: string, version: string): string {
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error('package.json has no "version" field');
  }
  return next;
}

export function setVersion(root: string, version: string): string[] {
  if (!validVersion(version)) throw new Error(`${version} is not a version like 0.2.0`);
  const files = versionedPackages(root);
  for (const f of files) {
    const path = join(root, f);
    writeFileSync(path, withVersion(readFileSync(path, 'utf8'), version));
  }
  return files;
}

if (import.meta.main) {
  const version = process.argv[2]?.replace(/^v/, '');
  if (!version) {
    console.error('Usage: pnpm run version:set <x.y.z>');
    process.exitCode = 1;
  } else {
    try {
      const files = setVersion(resolve(import.meta.dirname, '../../..'), version);
      console.log(`Set ${version} in:\n${files.map((f) => `  ${f}`).join('\n')}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
}
