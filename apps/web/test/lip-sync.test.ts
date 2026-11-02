// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinMsidStreams } from '../src/player/lip-sync.ts';

// SFU-style offers modelled on the Phase 0 capture : every
// pulled track in its own msid stream. The second one carries two streams in one SFU session (one
// session per room) and ssrc attributes.
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const AV = fixture('sfu-offer-av.sdp');
const TWO = fixture('sfu-offer-two-streams.sdp');

const msidLines = (sdp: string) =>
  sdp.split('\r\n').filter((l) => /^a=(msid:|ssrc:\d+ msid:)/.test(l));

describe('joinMsidStreams', () => {
  it('moves the audio into the video stream of a single-stream offer', () => {
    const out = joinMsidStreams(AV);
    expect(msidLines(out)).toEqual([
      'a=msid:RaqVWTNQ PCpocDcBwaIeBQfh',
      'a=msid:RaqVWTNQ CyVKFRNmzVgqQDJk',
    ]);
    expect(out).toContain('a=msid-semantic: WMS RaqVWTNQ\r\n');
    // Only the stream id changes: every other line and the CRLF endings stay.
    expect(
      out.replace('a=msid:RaqVWTNQ CyVKFRNmzVgqQDJk', 'a=msid:WVMbMatr CyVKFRNmzVgqQDJk'),
    ).toBe(AV.replace('WMS RaqVWTNQ WVMbMatr', 'WMS RaqVWTNQ'));
    expect(out.split('\r\n').length).toBe(AV.split('\r\n').length);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('pairs each audio with its own video when one session carries two streams', () => {
    const out = joinMsidStreams(TWO, [
      { video: '0', audio: '1' },
      { video: '2', audio: '3' },
    ]);
    expect(msidLines(out)).toEqual([
      'a=msid:RaqVWTNQ PCpocDcBwaIeBQfh',
      'a=ssrc:1111 msid:RaqVWTNQ PCpocDcBwaIeBQfh',
      'a=msid:RaqVWTNQ CyVKFRNmzVgqQDJk',
      'a=ssrc:2222 msid:RaqVWTNQ CyVKFRNmzVgqQDJk',
      'a=msid:ZfHhHVjs TpVvbbSTCrWNkIgo',
      'a=ssrc:3333 msid:ZfHhHVjs TpVvbbSTCrWNkIgo',
      'a=msid:ZfHhHVjs bzJkyAwBxsKhpuBN',
      'a=ssrc:4444 msid:ZfHhHVjs bzJkyAwBxsKhpuBN',
    ]);
    expect(out).toContain('a=msid-semantic: WMS RaqVWTNQ ZfHhHVjs\r\n');
    // The cname is not an msid and stays as it was.
    expect(out).toContain('a=ssrc:2222 cname:WVMbMatr');
  });

  it('does not guess with several videos and no pairs', () => {
    expect(joinMsidStreams(TWO)).toBe(TWO);
  });

  it('leaves unknown mids, already-joined offers and LF-only offers intact', () => {
    expect(joinMsidStreams(AV, [{ video: '9', audio: '1' }])).toBe(AV);
    const joined = joinMsidStreams(AV);
    expect(joinMsidStreams(joined)).toBe(joined);
    const lf = AV.replaceAll('\r\n', '\n');
    expect(joinMsidStreams(lf)).toBe(joined.replaceAll('\r\n', '\n'));
  });
});
