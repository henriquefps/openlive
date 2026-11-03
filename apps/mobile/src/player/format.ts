// SPDX-License-Identifier: AGPL-3.0-only
import type { Layer, Quality, Rid, StatsSample } from '@openlive/client';

// Text for the quality menu and the stats overlay.

/** "1080p60": the layer as the menu names it. */
export const layerLabel = (layer: Pick<Layer, 'height' | 'fps'>): string =>
  `${layer.height}p${Math.round(layer.fps)}`;

export interface QualityOption {
  value: Quality;
  /** The layer's label; null for Automatic. */
  label: string | null;
}

/** Automatic first, then the layers highest first. */
export function qualityOptions(layers: readonly Layer[]): QualityOption[] {
  if (layers.length < 2) return [];
  return [
    { value: 'auto', label: null },
    ...layers.map((l) => ({ value: l.rid as Quality, label: layerLabel(l) })),
  ];
}

export const layerOf = (layers: readonly Layer[], rid: Rid | null): Layer | null =>
  layers.find((l) => l.rid === rid) ?? null;

export interface StatsLine {
  key:
    | 'resolution'
    | 'fps'
    | 'bitrate'
    | 'loss'
    | 'jitterBuffer'
    | 'rtt'
    | 'codec'
    | 'layer'
    | 'decode'
    | 'ttff';
  value: string;
}

const fixed = (n: number, digits = 0) => n.toFixed(digits);

/** The rows of "stats for nerds" the sample has numbers for, in the order they are shown. */
export function statsLines(
  sample: StatsSample | null,
  extra: { layer: string | null; ttffMs: number | null; codec: string | null },
): StatsLine[] {
  const lines: StatsLine[] = [];
  if (sample?.width && sample.height) {
    lines.push({ key: 'resolution', value: `${sample.width}×${sample.height}` });
  }
  if (sample?.fps != null) lines.push({ key: 'fps', value: fixed(sample.fps) });
  if (sample?.bitrateBps != null) {
    lines.push({ key: 'bitrate', value: `${fixed(sample.bitrateBps / 1_000_000, 1)} Mbps` });
  }
  if (sample?.loss != null) lines.push({ key: 'loss', value: `${fixed(sample.loss * 100, 1)} %` });
  if (sample?.jitterBufferMs != null) {
    lines.push({ key: 'jitterBuffer', value: `${fixed(sample.jitterBufferMs)} ms` });
  }
  if (sample?.rttMs != null) lines.push({ key: 'rtt', value: `${fixed(sample.rttMs)} ms` });
  const codec = extra.codec ?? sample?.codec ?? null;
  if (codec) lines.push({ key: 'codec', value: codec.toUpperCase() });
  if (extra.layer) lines.push({ key: 'layer', value: extra.layer });
  if (sample?.decodeMs != null)
    lines.push({ key: 'decode', value: `${fixed(sample.decodeMs, 1)} ms` });
  if (extra.ttffMs != null) lines.push({ key: 'ttff', value: `${extra.ttffMs} ms` });
  return lines;
}
