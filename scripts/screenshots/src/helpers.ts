// SPDX-License-Identifier: AGPL-3.0-only
// The native helper, built from helper/ and paired as a dev user, publishing the synthetic test
// pattern: `test-stream` straight into a room, or `run --test-source` so "Go live" in the web
// finds it through the user hub. Its config and device token live in a throwaway directory.

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, type UserKey } from './seed.ts';
import { API, log, start, tempDir } from './stack.ts';

export function buildHelper(repo: string, outDir: string): string {
  const bin = join(outDir, 'openlive-helper');
  execFileSync('go', ['build', '-o', bin, './cmd/openlive-helper'], {
    cwd: join(repo, 'helper'),
    stdio: 'inherit',
  });
  return bin;
}

export interface Helper {
  bin: string;
  common: string[];
}

/** Pairs a helper with `user`'s account: device code flow, approved through the API. */
export async function pairHelper(bin: string, user: UserKey, name: string): Promise<Helper> {
  const configDir = tempDir('helper');
  const common = ['--instance', API, '--config-dir', configDir, '--insecure-token-file'];
  let resolveCode: (code: string) => void = () => undefined;
  const code = new Promise<string>((r) => (resolveCode = r));
  const pair = start(bin, ['pair', ...common, '--no-browser', '--name', name], {
    cwd: configDir,
    onLine: (line) => {
      const m = /enter the code (\S+)/.exec(line);
      if (m?.[1]) resolveCode(m[1]);
    },
  });
  const exited = new Promise<number | null>((r) => pair.on('exit', r));
  await api(user, 'POST', '/devices/approve', { userCode: await code, name });
  if ((await exited) !== 0) throw new Error(`pairing ${name} failed`);
  log(`helper "${name}" paired with ${user}`);
  return { bin, common };
}

/** Publishes the test pattern to a room until the run ends. */
export function testStream(helper: Helper, roomId: string, preset: string): void {
  start(
    helper.bin,
    ['test-stream', ...helper.common, '--room', roomId, '--preset', preset, '--tone=false'],
    {
      cwd: tmpdir(),
      onLine: (line) => process.env['VERBOSE'] && console.log('[test-stream]', line),
    },
  );
}

/** Keeps the helper connected to the user hub, offering the test pattern as a source. */
export function runHelper(helper: Helper): void {
  start(helper.bin, ['run', ...helper.common, '--test-source', '--minimized'], {
    cwd: tmpdir(),
    onLine: (line) => process.env['VERBOSE'] && console.log('[run]', line),
  });
}
