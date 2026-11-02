// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Applies the migrations with the real Wrangler CLI against a throwaway local
// D1, so a migration Wrangler rejects fails the suite. The tests themselves
// apply the same files inside workerd with applyD1Migrations().
export default function setup(): void {
  const persistTo = mkdtempSync(path.join(tmpdir(), 'openlive-d1-'));
  try {
    execFileSync(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo],
      {
        cwd: path.join(import.meta.dirname, '..'),
        stdio: 'pipe',
        env: { ...process.env, CI: '1' },
      },
    );
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    process.stderr.write(`${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}\n`);
    throw new Error('wrangler d1 migrations apply --local failed (output above)', { cause: err });
  } finally {
    rmSync(persistTo, { recursive: true, force: true });
  }
}
