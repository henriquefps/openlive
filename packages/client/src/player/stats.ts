// SPDX-License-Identifier: AGPL-3.0-only
import type { StatsReportLike } from './source.ts';

// getStats() → one sample per second: what "stats for nerds" shows, and what the
// Automatic policy and the watchdog decide on. Rates come from the difference to the previous
// sample, so the first sample has no fps, bitrate or loss yet.

/** Cumulative counters of the inbound video (and audio) RTP stream, kept between samples. */
export interface StatsCounters {
  at: number;
  framesDecoded: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  freezeCount: number;
  totalDecodeTime: number;
  framesDropped: number;
}

export interface StatsSample {
  /** ms timestamp of the report. */
  at: number;
  width: number | null;
  height: number | null;
  /** Decoded frames per second since the previous sample. */
  fps: number | null;
  /** Video plus audio, bits per second. */
  bitrateBps: number | null;
  /** Lost packets over expected packets since the previous sample, 0–1. */
  loss: number | null;
  /** Freezes (RTCInboundRtpStreamStats.freezeCount) since the previous sample. */
  newFreezes: number;
  /** Frames dropped before decode or render since the previous sample. */
  newFramesDropped: number;
  /** Frames decoded since the previous sample. */
  newFramesDecoded: number;
  jitterBufferMs: number | null;
  rttMs: number | null;
  codec: string | null;
  /** Mean decode time per frame since the previous sample. */
  decodeMs: number | null;
  /** Total frames decoded; the watchdog checks that it grows. */
  framesDecoded: number;
  /** Lifetime packet loss and freezes, for the overlay. */
  packetsLost: number;
  freezeCount: number;
  counters: StatsCounters;
}

type Entry = Record<string, unknown> & { type: string; id: string };

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `a` is the more current inbound stream: a later last packet, or more frames without one. */
function newer(a: Entry, b: Entry): boolean {
  const at = num(a['lastPacketReceivedTimestamp']);
  const bt = num(b['lastPacketReceivedTimestamp']);
  if (at !== null && bt !== null && at !== bt) return at > bt;
  if (at !== null && bt === null) return true;
  if (at === null && bt !== null) return false;
  return (num(a['framesDecoded']) ?? 0) > (num(b['framesDecoded']) ?? 0);
}

export function readStats(
  report: StatsReportLike,
  previous: StatsCounters | null,
  now: number,
): StatsSample {
  const entries = new Map<string, Entry>();
  report.forEach((entry) => entries.set(entry.id, entry));
  let video: Entry | null = null;
  let audioBytes = 0;
  let rttMs: number | null = null;
  for (const entry of entries.values()) {
    if (entry.type === 'inbound-rtp' && entry['kind'] === 'video') {
      // The player's stream is the one that got a packet last. An older one (a stopped receiver,
      // an RTP stream replaced on the same receiver) keeps its counters frozen: picking it for
      // having more frames made the watchdog see a stall while the video played.
      if (!video || newer(entry, video)) video = entry;
    } else if (entry.type === 'inbound-rtp' && entry['kind'] === 'audio') {
      audioBytes += num(entry['bytesReceived']) ?? 0;
    } else if (entry.type === 'candidate-pair' && entry['nominated'] === true) {
      const rtt = num(entry['currentRoundTripTime']);
      if (rtt !== null) rttMs = rtt * 1000;
    }
  }

  const counters: StatsCounters = {
    at: now,
    framesDecoded: num(video?.['framesDecoded']) ?? 0,
    bytesReceived: (num(video?.['bytesReceived']) ?? 0) + audioBytes,
    packetsReceived: num(video?.['packetsReceived']) ?? 0,
    packetsLost: Math.max(0, num(video?.['packetsLost']) ?? 0),
    freezeCount: num(video?.['freezeCount']) ?? 0,
    totalDecodeTime: num(video?.['totalDecodeTime']) ?? 0,
    framesDropped: num(video?.['framesDropped']) ?? 0,
  };

  const codecEntry = video ? entries.get(String(video['codecId'])) : undefined;
  const mime = codecEntry ? String(codecEntry['mimeType'] ?? '') : '';
  const emitted = num(video?.['jitterBufferEmittedCount']);
  const delay = num(video?.['jitterBufferDelay']);

  const sample: StatsSample = {
    at: now,
    width: num(video?.['frameWidth']),
    height: num(video?.['frameHeight']),
    fps: null,
    bitrateBps: null,
    loss: null,
    newFreezes: 0,
    newFramesDropped: 0,
    newFramesDecoded: 0,
    jitterBufferMs: emitted && delay !== null ? (delay / emitted) * 1000 : null,
    rttMs,
    codec: mime ? mime.replace(/^video\//, '') : null,
    decodeMs: null,
    framesDecoded: counters.framesDecoded,
    packetsLost: counters.packetsLost,
    freezeCount: counters.freezeCount,
    counters,
  };

  // A counter going backwards means a new RTP stream (a retry): start over from this sample.
  if (!previous || counters.framesDecoded < previous.framesDecoded) return sample;
  const seconds = (now - previous.at) / 1000;
  if (seconds <= 0) return sample;
  const frames = counters.framesDecoded - previous.framesDecoded;
  const received = counters.packetsReceived - previous.packetsReceived;
  const lost = Math.max(0, counters.packetsLost - previous.packetsLost);
  sample.fps = frames / seconds;
  sample.bitrateBps = Math.max(
    0,
    ((counters.bytesReceived - previous.bytesReceived) * 8) / seconds,
  );
  sample.loss = received + lost > 0 ? lost / (received + lost) : 0;
  sample.newFreezes = Math.max(0, counters.freezeCount - previous.freezeCount);
  sample.newFramesDropped = Math.max(0, counters.framesDropped - previous.framesDropped);
  sample.newFramesDecoded = frames;
  sample.decodeMs =
    frames > 0 ? ((counters.totalDecodeTime - previous.totalDecodeTime) / frames) * 1000 : null;
  return sample;
}
