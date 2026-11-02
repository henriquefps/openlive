// SPDX-License-Identifier: AGPL-3.0-only
// Terminal questions. Hidden answers are never echoed, not even as asterisks.

import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  let muted = true;
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = await rl.question('');
    return answer.trim();
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
}
