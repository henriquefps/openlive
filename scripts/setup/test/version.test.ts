// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validVersion, versionedPackages, withVersion } from '../src/version-set.ts';

const root = resolve(import.meta.dirname, '../../..');
const versionOf = (file: string) =>
  (JSON.parse(readFileSync(join(root, file), 'utf8')) as { version: string }).version;

describe('the project version', () => {
  it('is the root package.json version, copied into every app and package', () => {
    const projectVersion = versionOf('package.json');
    expect(validVersion(projectVersion)).toBe(true);
    const files = versionedPackages(root);
    expect(files).toEqual(
      expect.arrayContaining(['apps/api/package.json', 'apps/web/package.json']),
    );
    for (const f of files) expect([f, versionOf(f)]).toEqual([f, projectVersion]);
  });

  it('withVersion replaces only the version field', () => {
    const text =
      '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "1.2.3" }\n}\n';
    expect(withVersion(text, '0.2.0')).toBe(text.replace('0.1.0', '0.2.0'));
    expect(() => withVersion('{ "name": "x" }', '0.2.0')).toThrow(/no "version"/);
  });

  it('accepts x.y.z only', () => {
    expect(validVersion('0.2.0')).toBe(true);
    expect(validVersion('v0.2.0')).toBe(false);
    expect(validVersion('0.2')).toBe(false);
  });
});
