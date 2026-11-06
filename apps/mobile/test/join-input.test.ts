// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { normalizeRoomCode, parseJoinInput } from '../src/lib/join-input.ts';

const TOKEN = 'A'.repeat(43);

describe('normalizeRoomCode', () => {
  it('accepts the code in any form people type it', () => {
    for (const text of [
      'OL-4821-0937',
      'ol 4821 0937',
      '48210937',
      ' OL48210937 ',
      'OL-4821 0937',
    ]) {
      expect(normalizeRoomCode(text)).toBe('OL-4821-0937');
    }
  });
  it('rejects what is not a code', () => {
    for (const text of ['', 'OL-482-0937', 'hello', '4821-09375']) {
      expect(normalizeRoomCode(text)).toBeNull();
    }
  });
});

describe('parseJoinInput', () => {
  it('reads a bare invite token', () => {
    expect(parseJoinInput(` ${TOKEN}\n`)).toEqual({ kind: 'invite', token: TOKEN });
  });
  it('reads an invite page link and an app link', () => {
    expect(parseJoinInput(`https://live.example.com/invite/${TOKEN}`)).toEqual({
      kind: 'invite',
      token: TOKEN,
      instance: 'https://live.example.com',
    });
    expect(
      parseJoinInput(`openlive://join?instance=https%3A%2F%2Flive.example.com&invite=${TOKEN}`),
    ).toEqual({ kind: 'invite', token: TOKEN, instance: 'https://live.example.com' });
  });
  it('reads a room code and a room join link', () => {
    expect(parseJoinInput('ol 4821 0937')).toEqual({ kind: 'code', code: 'OL-4821-0937' });
    expect(parseJoinInput('https://live.example.com/join/OL-4821-0937')).toEqual({
      kind: 'code',
      code: 'OL-4821-0937',
      instance: 'https://live.example.com',
    });
  });
  it('does not guess', () => {
    expect(parseJoinInput('')).toEqual({ kind: 'unknown' });
    expect(parseJoinInput('just some words')).toEqual({ kind: 'unknown' });
    expect(parseJoinInput('https://live.example.com/join/not-a-code')).toEqual({ kind: 'unknown' });
  });
});
