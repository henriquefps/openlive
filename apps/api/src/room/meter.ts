// SPDX-License-Identifier: AGPL-3.0-only
import type { Preset, RoomSettings } from '@openlive/protocol';
import {
  type Av1Mode,
  cameraLayerKbps,
  codecKbps,
  joinGB,
  type Overheads,
  viewerStreamGB,
  VOICE_KBPS,
} from '@openlive/usage';
import type { MeterRow, RoomStore } from './store';

// The RoomDO's usage meter. Between two events nothing changes in a
// room, so the DO accrues at the start of every event: each held slot adds the elapsed seconds at
// the bitrate of the layer its viewer pulled, each live stream adds stream-seconds. A subscribe
// adds one join at its layer's bitrate. Totals are kept raw (megabit-seconds, summed join Mbps),
// because the cost formula is linear in both, and turned into GB only at flush time, with the
// overheads the platform admin chose. A join is charged at the top layer's rate (the SFU starts
// every pull there), so a hover pre-pull on the low layer still pays a full join.
// Voice: each pulled microphone adds VOICE_KBPS to the same
// megabit-seconds, so it goes through the same formula; it adds no viewer minutes and no joins.
// Cameras (docs/PROTOCOL.md 7.7): each pulled camera adds its layer's bitrate (500 kbps high, 150
// kbps low) the same way, and each camera pull adds a join at the high layer's rate. A stream's
// AV1 track is counted for the viewers that pull it at its mode's share of the
// H.264 layer's bitrate (AV1_MODE_PERCENT; the room's av1QualityPresets give the mode of the
// stream's preset), joins included.
// The totals accrue in memory at every event and are written only when the rates change (a slot,
// pull or stream comes or goes: rateKey), after a join and after a flush. An
// eviction in between loses nothing: the stored row accrued from its last_at at the same rates
// gives the same totals.

/** Middle and low simulcast layers (720p60 3–5 Mbps, 480p30 0.8–1.5 Mbps). */
const LAYER_KBPS = [Infinity, 4_000, 1_200];

/** The bitrate a viewer of `rid` receives: the publish's top bitrate, capped per layer. */
export function layerKbps(topKbps: number, rids: readonly string[], rid: string | null): number {
  const index = rid === null ? 0 : Math.max(0, rids.indexOf(rid));
  return Math.min(topKbps, LAYER_KBPS[Math.min(index, LAYER_KBPS.length - 1)] ?? Infinity);
}

export interface StreamRates {
  /** Top-layer bitrate of each live stream. */
  topKbps: Map<string, number>;
  /** Simulcast rids of each live stream's video, highest first; empty when not simulcast. */
  rids: Map<string, readonly string[]>;
  /** The AV1 mode of each live stream's AV1 track (av1ModeFor); absent is `save`. */
  av1Modes?: Map<string, Av1Mode>;
}

/** The AV1 mode of a stream of `preset` in a room: `quality` where the room says. */
export function av1ModeFor(settings: RoomSettings | null, preset: Preset): Av1Mode {
  return settings?.av1QualityPresets?.includes(preset) ? 'quality' : 'save';
}

/** What accrues per second, as a key: the meter is saved when it changes. */
export function rateKey(store: RoomStore, rates: StreamRates): string {
  return keyOf(inputsOf(store), rates);
}

interface RateInputs {
  layers: ReturnType<RoomStore['slotLayers']>;
  voicePulls: number;
  cameraLayers: ReturnType<RoomStore['cameraPullLayers']>;
}

function inputsOf(store: RoomStore): RateInputs {
  return {
    layers: store.slotLayers(),
    voicePulls: store.voicePullCount(),
    cameraLayers: store.cameraPullLayers(),
  };
}

function keyOf(i: RateInputs, rates: StreamRates): string {
  return JSON.stringify([
    i.layers.map((l) => `${l.stream_id}/${l.rid}/${l.codec}`).sort(),
    [...rates.topKbps].sort(),
    [...rates.rids].sort(),
    [...(rates.av1Modes ?? [])].sort(),
    i.voicePulls,
    i.cameraLayers.map((c) => String(c.rid)).sort(),
  ]);
}

/**
 * Adds the time since the last accrual to the running totals, in memory (RoomStore.saveMeter
 * writes them). Returns the rates' key (rateKey).
 */
export function accrue(store: RoomStore, rates: StreamRates, now: number): string {
  const i = inputsOf(store);
  const m = store.meter(now);
  const dt = Math.max(0, (now - m.last_at) / 1000);
  if (dt > 0) {
    for (const slot of i.layers) {
      const top = rates.topKbps.get(slot.stream_id);
      if (top === undefined) continue;
      // An AV1 viewer receives the AV1 track's bitrate, by its mode (0046).
      const kbps = codecKbps(
        layerKbps(top, rates.rids.get(slot.stream_id) ?? [], slot.rid),
        slot.codec,
        rates.av1Modes?.get(slot.stream_id),
      );
      m.viewer_mbit_s += (kbps / 1000) * dt;
      m.viewer_s += dt;
    }
    m.stream_s += rates.topKbps.size * dt;
    m.viewer_mbit_s += ((i.voicePulls * VOICE_KBPS) / 1000) * dt;
    for (const pull of i.cameraLayers) {
      m.viewer_mbit_s += (cameraLayerKbps(pull.rid) / 1000) * dt;
    }
  }
  store.setMeter({ ...m, last_at: now });
  return keyOf(i, rates);
}

/** One viewer join (a pull) at `kbps`, written at once. Accrue first. */
export function addJoin(store: RoomStore, kbps: number, now: number): void {
  const m = store.meter(now);
  store.setMeter({ ...m, join_mbps: m.join_mbps + kbps / 1000 });
  store.saveMeter();
}

export interface Flush {
  gb: number;
  viewerMinutes: number;
  streamMinutes: number;
  /** The totals left after the flush: whole minutes and all GB are written, the rest kept. */
  rest: MeterRow;
}

export function flushAmounts(m: MeterRow, o: Overheads): Flush {
  const viewerMinutes = Math.floor(m.viewer_s / 60);
  const streamMinutes = Math.floor(m.stream_s / 60);
  return {
    gb: viewerStreamGB(m.viewer_mbit_s, 1, o) + joinGB(m.join_mbps, o),
    viewerMinutes,
    streamMinutes,
    rest: {
      ...m,
      viewer_mbit_s: 0,
      join_mbps: 0,
      viewer_s: m.viewer_s - viewerMinutes * 60,
      stream_s: m.stream_s - streamMinutes * 60,
    },
  };
}
