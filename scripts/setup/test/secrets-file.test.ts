// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  filledSecrets,
  parseSecretsFile,
  SecretsFileError,
  setSecret,
} from '../src/secrets-file.ts';

describe('parseSecretsFile', () => {
  it('reads KEY=VALUE lines, comments, quotes and export', () => {
    const text = [
      '# comment',
      '',
      'A=plain',
      'B="with space \\"q\\""',
      "C='single # kept'",
      'export D=exported',
      'E=value # inline comment',
      'F=',
    ].join('\n');
    expect(Object.fromEntries(parseSecretsFile(text))).toEqual({
      A: 'plain',
      B: 'with space "q"',
      C: 'single # kept',
      D: 'exported',
      E: 'value',
      F: '',
    });
  });

  it('handles CRLF', () => {
    expect(parseSecretsFile('A=1\r\nB=2\r\n').get('B')).toBe('2');
  });

  it('rejects duplicates and bad lines without echoing values', () => {
    expect(() => parseSecretsFile('A=s3cr3t-value\nA=other')).toThrow(SecretsFileError);
    expect(() => parseSecretsFile('A=s3cr3t-value\nA=other')).toThrow(/line 2: duplicate key A/);
    for (const bad of ['no-equals-s3cr3t', 'lower=s3cr3t', 'A="s3cr3t', '=s3cr3t']) {
      try {
        parseSecretsFile(bad);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SecretsFileError);
        expect((err as Error).message).not.toContain('s3cr3t');
      }
    }
  });

  it('filledSecrets drops placeholders', () => {
    expect([...filledSecrets(parseSecretsFile('A=\nB=x')).keys()]).toEqual(['B']);
  });
});

describe('setSecret', () => {
  it('replaces an existing line in place and keeps comments', () => {
    const text = '# header\nA=\n# between\nB=old\n';
    expect(setSecret(text, 'B', 'new')).toBe('# header\nA=\n# between\nB=new\n');
    expect(setSecret(text, 'A', 'x')).toBe('# header\nA=x\n# between\nB=old\n');
  });

  it('appends a missing key with one trailing newline', () => {
    expect(setSecret('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
    expect(setSecret('', 'B', '2')).toBe('B=2\n');
  });

  it('quotes values that need it and round-trips them', () => {
    const value = 'has space "and" # hash';
    const text = setSecret('', 'K', value);
    expect(text).toBe(`K=${JSON.stringify(value)}\n`);
    expect(parseSecretsFile(text).get('K')).toBe(value);
    expect(setSecret('', 'T', 'abc-_.:/+=@')).toBe('T=abc-_.:/+=@\n');
  });

  it('rejects invalid key names', () => {
    expect(() => setSecret('', 'bad-key', 'v')).toThrow(SecretsFileError);
  });
});
