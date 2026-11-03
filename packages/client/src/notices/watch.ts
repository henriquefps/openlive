// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperState } from '@openlive/protocol';
import type { HubState } from '../hub/connection.ts';
import type { RoomState } from '../room/connection.ts';
import type { NoticeEvent } from './policy.ts';

// Where the notices come from. The room socket already says
// everything about the rooms this tab has open (the page shown, the voice): a stream started, a
// slot opened in the queue, someone started watching your stream, and who joins or leaves the voice
// you are in. The hub says what your helpers do: a stream that dropped, a network that is
// unstable. Each watcher compares one state with the next; the first state it sees is only taken
// in, so opening a page or reconnecting is never a notice.

export interface Notice {
  event: NoticeEvent;
  /** Who: the streamer, the viewer, the person in voice. */
  userId?: string;
  streamId?: string;
}

/** One room's notices, from its socket's states. */
export class RoomNoticeWatcher {
  private prev: RoomState | null = null;
  /** Streams that started while this watcher was looking: their first viewers are new. */
  private readonly fresh = new Set<string>();

  update(next: RoomState): Notice[] {
    const prev = this.prev;
    this.prev = next;
    // Only between two open states: the welcome (first or after a reconnect) lists what was
    // already there.
    if (!prev || prev.status !== 'open' || next.status !== 'open') {
      if (next.status === 'open') this.fresh.clear();
      return [];
    }
    const me = next.you?.userId ?? null;
    const notices: Notice[] = [];

    const before = new Set(prev.streams.map((s) => s.streamId));
    for (const stream of next.streams) {
      if (before.has(stream.streamId)) continue;
      this.fresh.add(stream.streamId);
      if (stream.userId !== me) {
        notices.push({ event: 'streamStarted', userId: stream.userId, streamId: stream.streamId });
      }
    }

    for (const stream of next.streams) {
      if (stream.userId !== me) continue;
      const now = next.viewers[stream.streamId];
      const then = prev.viewers[stream.streamId];
      if (!now || now === then) continue;
      // The first count of a stream that was already live is a baseline, not news.
      if (!then && !this.fresh.has(stream.streamId)) continue;
      const seen = new Set(then?.viewerUserIds ?? []);
      for (const userId of new Set(now.viewerUserIds)) {
        if (userId !== me && !seen.has(userId)) {
          notices.push({ event: 'viewerJoined', userId, streamId: stream.streamId });
        }
      }
    }

    for (const [streamId, access] of Object.entries(next.access)) {
      const was = prev.access[streamId];
      if (access.kind !== 'offer') continue;
      if (was?.kind === 'offer' && was.offerId === access.offerId) continue;
      const stream = next.streams.find((s) => s.streamId === streamId);
      notices.push({ event: 'queueSlot', streamId, ...(stream ? { userId: stream.userId } : {}) });
    }

    const wasIn = prev.voice.self === 'in';
    const isIn = next.voice.self === 'in';
    if (!wasIn && isIn) notices.push({ event: 'voiceJoinSelf' });
    if (wasIn && !isIn) notices.push({ event: 'voiceLeaveSelf' });
    if (wasIn && isIn) {
      const self = next.voice.selfId;
      const had = new Set(prev.voice.participants.map((p) => p.userId));
      const has = new Set(next.voice.participants.map((p) => p.userId));
      for (const userId of has) {
        if (userId !== self && !had.has(userId)) notices.push({ event: 'voiceJoin', userId });
      }
      for (const userId of had) {
        if (userId !== self && !has.has(userId)) notices.push({ event: 'voiceLeave', userId });
      }
    }
    return notices;
  }
}

/**
 * Tells from a helper's per-second stats when the network is unstable: the target bitrate cut
 * well below the stream's best, or packets being lost, for ten samples in a row; as many good
 * ones make it stable again. The helper's NetworkWatch (helper/internal/notify/network.go), so
 * both say the same thing.
 */
export class NetworkWatch {
  private peak = 0;
  private bad = 0;
  private good = 0;
  unstable = false;

  constructor(
    private readonly after = 10,
    private readonly cutRatio = 0.5,
    private readonly lossPct = 5,
  ) {}

  /** One sample; true when the network just became unstable. */
  observe(targetKbps: number, lossPct: number): boolean {
    if (targetKbps > this.peak) this.peak = targetKbps;
    const bad =
      lossPct >= this.lossPct || (this.peak > 0 && targetKbps < this.cutRatio * this.peak);
    if (bad) {
      this.bad += 1;
      this.good = 0;
    } else {
      this.good += 1;
      this.bad = 0;
    }
    if (!this.unstable && this.bad >= this.after) {
      this.unstable = true;
      return true;
    }
    if (this.unstable && this.good >= this.after) this.unstable = false;
    return false;
  }
}

const STREAMING: readonly HelperState[] = ['live', 'paused'];

/** Your helpers' notices, from the hub's states: a stream that dropped, an unstable network. */
export class HubNoticeWatcher {
  private prev: HubState | null = null;
  private readonly networks = new Map<string, NetworkWatch>();

  update(next: HubState): Notice[] {
    const prev = this.prev;
    this.prev = next;
    // A hub reconnect rebuilds the lists: not a drop.
    if (!prev || prev.status !== 'open' || next.status !== 'open') return [];
    const notices: Notice[] = [];
    for (const [deviceId, was] of Object.entries(prev.statuses)) {
      if (!STREAMING.includes(was.state)) continue;
      const now = next.statuses[deviceId];
      const gone = prev.helpers[deviceId] !== undefined && next.helpers[deviceId] === undefined;
      if (gone || now?.state === 'error') {
        notices.push({
          event: 'streamDropped',
          ...(was.stream?.streamId ? { streamId: was.stream.streamId } : {}),
        });
      }
    }
    for (const [deviceId, status] of Object.entries(next.statuses)) {
      if (!STREAMING.includes(status.state)) this.networks.delete(deviceId);
    }
    for (const [deviceId, stats] of Object.entries(next.stats)) {
      if (stats === prev.stats[deviceId]) continue;
      if (!STREAMING.includes(next.statuses[deviceId]?.state ?? 'idle')) continue;
      let watch = this.networks.get(deviceId);
      if (!watch) {
        watch = new NetworkWatch();
        this.networks.set(deviceId, watch);
      }
      if (watch.observe(stats.targetBitrateKbps, stats.packetLossPct)) {
        notices.push({ event: 'streamUnstable', streamId: stats.streamId });
      }
    }
    return notices;
  }
}
