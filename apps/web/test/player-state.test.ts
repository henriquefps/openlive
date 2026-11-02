// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamInfo } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import { type ScreenInput, screenFor } from '../src/player/screens.ts';
import {
  clampVolume,
  DEFAULT_VOLUME,
  loadVolume,
  saveVolume,
  stepVolume,
} from '../src/player/volume.ts';

describe('volume per streamer', () => {
  it('remembers volume and mute per streamer, and defaults for new ones', () => {
    saveVolume('u_ana', { volume: 0.35, muted: false });
    saveVolume('u_bruno', { volume: 1, muted: true });
    expect(loadVolume('u_ana')).toEqual({ volume: 0.35, muted: false });
    expect(loadVolume('u_bruno')).toEqual({ volume: 1, muted: true });
    expect(loadVolume('u_carol')).toEqual(DEFAULT_VOLUME);
  });

  it('survives junk and missing storage', () => {
    localStorage.setItem('openlive.volume.u_ana', '{not json');
    expect(loadVolume('u_ana')).toEqual(DEFAULT_VOLUME);
    localStorage.setItem('openlive.volume.u_ana', JSON.stringify({ volume: 7 }));
    expect(loadVolume('u_ana')).toEqual({ volume: 1, muted: false });
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    } as unknown as Storage;
    expect(loadVolume('u_ana', broken)).toEqual(DEFAULT_VOLUME);
    expect(() => saveVolume('u_ana', DEFAULT_VOLUME, broken)).not.toThrow();
  });

  it('steps by 5% within 0–1, and turning it up unmutes', () => {
    expect(stepVolume({ volume: 0.8, muted: false }, 1)).toEqual({ volume: 0.85, muted: false });
    expect(stepVolume({ volume: 1, muted: false }, 1).volume).toBe(1);
    expect(stepVolume({ volume: 0.02, muted: false }, -1).volume).toBe(0);
    expect(stepVolume({ volume: 0.5, muted: true }, 1).muted).toBe(false);
    expect(stepVolume({ volume: 0.5, muted: true }, -1).muted).toBe(true);
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_VOLUME.volume);
  });
});

const STREAM: StreamInfo = {
  streamId: 'st_1',
  userId: 'u_ana',
  deviceId: 'd_1',
  source: { kind: 'window', label: 'Hades II' },
  preset: 'game',
  hasAudio: true,
  paused: false,
  startedAt: 0,
  viewerLimit: 6,
  viewerCount: 2,
};

const LIVE: ScreenInput = {
  room: { status: 'open', ended: null },
  stream: STREAM,
  endedReason: null,
  access: { kind: 'granted', slotId: 'sl_1', expiresAt: 0, leaseMs: 30_000 },
  source: { kind: 'live' },
  trackMuted: false,
  firstFrame: true,
  unstable: false,
};

const screen = (patch: Partial<ScreenInput>) => screenFor({ ...LIVE, ...patch });

describe('state → screen', () => {
  it('maps every state to its own screen', () => {
    const cases: [Partial<ScreenInput>, string][] = [
      [{}, 'live'],
      [{ unstable: true }, 'unstable'],
      [{ room: { status: 'connecting', ended: null } }, 'connecting'],
      [{ access: null, source: null }, 'connecting'],
      [{ access: { kind: 'requesting' }, source: null }, 'connecting'],
      [{ source: { kind: 'connecting' } }, 'connecting'],
      [{ firstFrame: false }, 'connecting'],
      [{ stream: { ...STREAM, paused: true, pauseReason: 'source_hidden' } }, 'paused'],
      [{ stream: { ...STREAM, paused: true, pauseReason: 'user' } }, 'paused'],
      [{ trackMuted: true }, 'paused'],
      [{ stream: { ...STREAM, paused: true, pauseReason: 'privacy_curtain' } }, 'curtain'],
      [{ room: { status: 'reconnecting', ended: null } }, 'reconnecting'],
      [{ source: { kind: 'reconnecting', attempt: 2 } }, 'reconnecting'],
      [{ source: { kind: 'failed', reason: 'network' } }, 'reconnecting'],
      [{ stream: null, endedReason: 'ended_by_streamer' }, 'ended'],
      [{ stream: null }, 'ended'],
      [{ room: { status: 'ended', ended: { kind: 'closed', reason: 'archived' } } }, 'ended'],
      [{ access: { kind: 'denied', code: 'forbidden' } }, 'noPermission'],
      [{ source: { kind: 'failed', reason: 'no_permission' } }, 'noPermission'],
      [{ room: { status: 'ended', ended: { kind: 'kicked', reason: 'banned' } } }, 'noPermission'],
      [{ room: { status: 'ended', ended: { kind: 'forbidden' } } }, 'noPermission'],
      [{ room: { status: 'ended', ended: { kind: 'closed', reason: 'expired' } } }, 'roomExpired'],
      [{ stream: null, endedReason: 'helper_disconnected' }, 'helperOffline'],
      [{ source: { kind: 'failed', reason: 'helper_outdated' } }, 'helperOutdated'],
      [{ access: { kind: 'full', queue: null }, source: null }, 'full'],
      [{ access: { kind: 'full', queue: { position: 2, length: 3 } }, source: null }, 'full'],
      [{ access: { kind: 'offer', offerId: 'of_1', expiresAt: 0 }, source: null }, 'full'],
    ];
    for (const [patch, expected] of cases) {
      expect([patch, screen(patch)]).toEqual([patch, expected]);
    }
  });

  it('never shows "paused" for a new track that is still muted before its first frame', () => {
    expect(screen({ trackMuted: true, firstFrame: false })).toBe('connecting');
  });

  it('puts the room before the stream and the streamer before the transport', () => {
    expect(
      screen({
        room: { status: 'reconnecting', ended: null },
        stream: { ...STREAM, paused: true, pauseReason: 'privacy_curtain' },
      }),
    ).toBe('reconnecting');
    expect(
      screen({
        stream: { ...STREAM, paused: true, pauseReason: 'privacy_curtain' },
        source: { kind: 'reconnecting', attempt: 1 },
      }),
    ).toBe('curtain');
  });
});
