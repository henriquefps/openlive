// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, StreamInfo } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import { type HubState, INITIAL_HUB_STATE } from '../src/hub/connection.ts';
import { INITIAL_STATE, INITIAL_VOICE, type RoomState } from '../src/room/connection.ts';
import { HubNoticeWatcher, NetworkWatch, RoomNoticeWatcher } from '../src/notices/watch.ts';
import { participant } from './voice-fakes.ts';
import { STREAM } from './rtc-fakes.ts';

// Where the notices come from: the room socket's states (streams, viewers, queue offers, voice)
// and the hub's (your helpers). The first state is only taken in, and so is a reconnect.

const ME = 'u_me';

const open = (patch: Partial<RoomState> = {}): RoomState => ({
  ...INITIAL_STATE,
  status: 'open',
  you: {
    userId: ME,
    connectionId: 'c_1',
    role: 'member',
    permissions: {} as never,
  },
  ...patch,
});

const stream = (patch: Partial<StreamInfo> = {}): StreamInfo => ({ ...STREAM, ...patch });

const viewers = (streamId: string, ids: string[]) => ({
  [streamId]: { streamId, viewerUserIds: ids, used: ids.length, limit: 6, queueLength: 0 },
});

describe('RoomNoticeWatcher', () => {
  it('the first state and a reconnect are not news', () => {
    const w = new RoomNoticeWatcher();
    expect(w.update(open({ streams: [stream()] }))).toEqual([]);
    expect(w.update(open({ status: 'reconnecting', streams: [stream()] }))).toEqual([]);
    expect(w.update(open({ streams: [stream(), stream({ streamId: 'st_2' })] }))).toEqual([]);
  });

  it('someone else starting a stream is; your own is not', () => {
    const w = new RoomNoticeWatcher();
    w.update(open());
    expect(w.update(open({ streams: [stream()] }))).toEqual([
      { event: 'streamStarted', userId: 'u_ana', streamId: 'st_1' },
    ]);
    expect(
      w.update(open({ streams: [stream(), stream({ streamId: 'st_me', userId: ME })] })),
    ).toEqual([]);
  });

  it('new viewers of your stream, not of others, and not yourself', () => {
    const mine = stream({ streamId: 'st_me', userId: ME });
    const w = new RoomNoticeWatcher();
    w.update(open());
    w.update(open({ streams: [mine] }));
    expect(w.update(open({ streams: [mine], viewers: viewers('st_me', ['u_bia', ME]) }))).toEqual([
      { event: 'viewerJoined', userId: 'u_bia', streamId: 'st_me' },
    ]);
    expect(
      w.update(open({ streams: [mine], viewers: viewers('st_me', ['u_bia', 'u_cai']) })),
    ).toEqual([{ event: 'viewerJoined', userId: 'u_cai', streamId: 'st_me' }]);
    // Someone leaving is not a notice.
    expect(w.update(open({ streams: [mine], viewers: viewers('st_me', ['u_cai']) }))).toEqual([]);
  });

  it('a stream already live when the page opened: its first viewer list is a baseline', () => {
    const mine = stream({ streamId: 'st_me', userId: ME });
    const w = new RoomNoticeWatcher();
    w.update(open({ streams: [mine] }));
    expect(w.update(open({ streams: [mine], viewers: viewers('st_me', ['u_bia']) }))).toEqual([]);
    expect(
      w.update(open({ streams: [mine], viewers: viewers('st_me', ['u_bia', 'u_cai']) })),
    ).toEqual([{ event: 'viewerJoined', userId: 'u_cai', streamId: 'st_me' }]);
  });

  it('a slot offered in the queue, once per offer', () => {
    const w = new RoomNoticeWatcher();
    const base = { streams: [stream()] };
    w.update(
      open({ ...base, access: { st_1: { kind: 'full', queue: { position: 1, length: 1 } } } }),
    );
    const offer = { kind: 'offer' as const, offerId: 'of_1', expiresAt: 30_000 };
    expect(w.update(open({ ...base, access: { st_1: offer } }))).toEqual([
      { event: 'queueSlot', streamId: 'st_1', userId: 'u_ana' },
    ]);
    expect(w.update(open({ ...base, access: { st_1: { ...offer } } }))).toEqual([]);
    expect(w.update(open({ ...base, access: { st_1: { ...offer, offerId: 'of_2' } } }))).toEqual([
      { event: 'queueSlot', streamId: 'st_1', userId: 'u_ana' },
    ]);
  });

  it('voice: you join and leave; others join and leave while you are in', () => {
    const voice = (patch: Partial<RoomState['voice']>) =>
      open({ voice: { ...INITIAL_VOICE, selfId: ME, ...patch } });
    const w = new RoomNoticeWatcher();
    w.update(voice({ participants: [participant('u_bia')] }));
    // Someone joining a voice you are not in: nothing.
    expect(w.update(voice({ participants: [participant('u_bia'), participant('u_cai')] }))).toEqual(
      [],
    );
    // You join: the list comes with it, and is not a burst of joins.
    const inVoice = [participant('u_bia'), participant('u_cai'), participant(ME)];
    expect(w.update(voice({ self: 'in', participants: inVoice }))).toEqual([
      { event: 'voiceJoinSelf' },
    ]);
    expect(
      w.update(voice({ self: 'in', participants: [...inVoice, participant('u_dan')] })),
    ).toEqual([{ event: 'voiceJoin', userId: 'u_dan' }]);
    expect(w.update(voice({ self: 'in', participants: [participant(ME)] }))).toEqual([
      { event: 'voiceLeave', userId: 'u_bia' },
      { event: 'voiceLeave', userId: 'u_cai' },
      { event: 'voiceLeave', userId: 'u_dan' },
    ]);
    expect(w.update(voice({ self: 'out', participants: [] }))).toEqual([
      { event: 'voiceLeaveSelf' },
    ]);
  });
});

describe('NetworkWatch (the helper’s rule)', () => {
  it('unstable after ten bad samples in a row, once; stable after ten good', () => {
    const w = new NetworkWatch();
    for (let i = 0; i < 9; i++) expect(w.observe(4000, 8)).toBe(false);
    expect(w.observe(4000, 8)).toBe(true);
    expect(w.observe(4000, 8)).toBe(false);
    for (let i = 0; i < 10; i++) w.observe(4000, 0);
    expect(w.unstable).toBe(false);
  });

  it('a target cut below half of the best counts as bad; a short dip does not', () => {
    const w = new NetworkWatch();
    w.observe(6000, 0);
    for (let i = 0; i < 5; i++) w.observe(2000, 0);
    w.observe(6000, 0);
    for (let i = 0; i < 9; i++) expect(w.observe(2000, 0)).toBe(false);
    expect(w.observe(2000, 0)).toBe(true);
  });
});

describe('HubNoticeWatcher', () => {
  const helper = { deviceId: 'd_1' } as HelperInfo;
  const hub = (patch: Partial<HubState> = {}): HubState => ({
    ...INITIAL_HUB_STATE,
    status: 'open',
    helpers: { d_1: helper },
    ...patch,
  });
  const status = (state: 'live' | 'error' | 'idle' | 'stopping') => ({
    d_1: {
      deviceId: 'd_1',
      state,
      stream: { roomId: 'r_1', streamId: 'st_me', sourceId: 's', preset: 'game' as const },
    },
  });
  const stats = (targetBitrateKbps: number, packetLossPct: number) => ({
    d_1: {
      deviceId: 'd_1',
      streamId: 'st_me',
      targetBitrateKbps,
      sentBitrateKbps: targetBitrateKbps,
      fps: 60,
      width: 1920,
      height: 1080,
      packetLossPct,
      rttMs: 20,
    },
  });

  it('a live stream ending in error, or its helper going away, dropped', () => {
    const w = new HubNoticeWatcher();
    w.update(hub({ statuses: status('live') }));
    expect(w.update(hub({ statuses: status('error') }))).toEqual([
      { event: 'streamDropped', streamId: 'st_me' },
    ]);
    const v = new HubNoticeWatcher();
    v.update(hub({ statuses: status('live') }));
    expect(v.update(hub({ helpers: {}, statuses: status('live') }))).toEqual([
      { event: 'streamDropped', streamId: 'st_me' },
    ]);
  });

  it('stopping on purpose, or the hub reconnecting, is not a drop', () => {
    const w = new HubNoticeWatcher();
    w.update(hub({ statuses: status('live') }));
    expect(w.update(hub({ statuses: status('stopping') }))).toEqual([]);
    expect(w.update(hub({ statuses: status('idle') }))).toEqual([]);
    const v = new HubNoticeWatcher();
    v.update(hub({ statuses: status('live') }));
    expect(v.update(hub({ status: 'reconnecting', helpers: {}, statuses: {} }))).toEqual([]);
  });

  it('ten seconds of bad stats while live: unstable, once', () => {
    const w = new HubNoticeWatcher();
    w.update(hub({ statuses: status('live') }));
    const notices = [];
    for (let i = 0; i < 12; i++) {
      notices.push(...w.update(hub({ statuses: status('live'), stats: stats(3000, 10) })));
    }
    expect(notices).toEqual([{ event: 'streamUnstable', streamId: 'st_me' }]);
  });
});
