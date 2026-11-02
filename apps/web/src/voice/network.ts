// SPDX-License-Identifier: AGPL-3.0-only
import type { StatsReportLike } from '../player/source.ts';
import type { NetworkQuality } from './camera.ts';

// How the room's SFU session is doing, for the cameras (voice
// first). Every few seconds the session's stats give the packet loss of what is received (voice
// and cameras) and the round trip of the selected candidate pair. It gets worse at once and better
// only after a few good samples, so the cameras do not flap between layers.

export interface NetworkSample {
  /** Packets lost since the last sample, in percent of those expected. */
  lossPct: number;
  /** The selected candidate pair's round trip, if known. */
  rttMs: number | null;
}

export const POOR = { lossPct: 3, rttMs: 400 };
export const BAD = { lossPct: 10, rttMs: 800 };
/** Good samples in a row before the quality goes back up one step. */
export const RECOVER_SAMPLES = 3;

export function qualityOf(sample: NetworkSample): NetworkQuality {
  const rtt = sample.rttMs ?? 0;
  if (sample.lossPct >= BAD.lossPct || rtt >= BAD.rttMs) return 'bad';
  if (sample.lossPct >= POOR.lossPct || rtt >= POOR.rttMs) return 'poor';
  return 'good';
}

const RANK: Record<NetworkQuality, number> = { good: 0, poor: 1, bad: 2 };
const BY_RANK: NetworkQuality[] = ['good', 'poor', 'bad'];

/** Turns raw stats into samples (loss between two calls) and samples into a steady quality. */
export class NetworkMeter {
  private lost = 0;
  private received = 0;
  private quality: NetworkQuality = 'good';
  private better = 0;

  sample(stats: StatsReportLike): NetworkSample {
    let lost = 0;
    let received = 0;
    let rttMs: number | null = null;
    stats.forEach((report) => {
      const r = report as {
        type?: string;
        packetsLost?: number;
        packetsReceived?: number;
        state?: string;
        nominated?: boolean;
        currentRoundTripTime?: number;
      };
      if (r.type === 'inbound-rtp') {
        lost += r.packetsLost ?? 0;
        received += r.packetsReceived ?? 0;
      } else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        if (typeof r.currentRoundTripTime === 'number') rttMs = r.currentRoundTripTime * 1000;
      }
    });
    const dLost = Math.max(0, lost - this.lost);
    const dReceived = Math.max(0, received - this.received);
    this.lost = lost;
    this.received = received;
    const expected = dLost + dReceived;
    return { lossPct: expected > 0 ? (dLost / expected) * 100 : 0, rttMs };
  }

  /** The next steady quality: worse at once, better one step after RECOVER_SAMPLES good ones. */
  update(sample: NetworkSample): NetworkQuality {
    const now = qualityOf(sample);
    if (RANK[now] >= RANK[this.quality]) {
      this.better = 0;
      this.quality = now;
    } else if (++this.better >= RECOVER_SAMPLES) {
      this.better = 0;
      this.quality = BY_RANK[RANK[this.quality] - 1] ?? 'good';
    }
    return this.quality;
  }
}
