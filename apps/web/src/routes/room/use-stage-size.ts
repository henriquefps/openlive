// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CameraClient } from '../../voice/camera.ts';
import { pickHighLayers } from './stage-layout.ts';

export interface Size {
  width: number;
  height: number;
}

/**
 * The size of an element (CSS pixels, rounded down), kept up to date with a ResizeObserver. A
 * callback ref, since the stage's area is only there in some modes. 0×0 until measured (and in
 * environments without ResizeObserver, after the first measure).
 */
export function useElementSize(): [(element: HTMLElement | null) => void, Size] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

/** How long tile sizes must hold before the cameras switch layer (no flapping on a resize). */
export const LAYER_DEBOUNCE_MS = 400;

/**
 * Asks the camera client for the high layer on the cameras the stage shows large
 * (pickHighLayers: hysteresis, at most four), once the sizes hold for LAYER_DEBOUNCE_MS.
 */
export function useHighLayers(
  client: CameraClient | null | undefined,
  widths: ReadonlyMap<string, number> | null,
): void {
  const previous = useRef<ReadonlySet<string>>(new Set());
  const latest = useRef(widths);
  useEffect(() => {
    latest.current = widths;
  });
  const key = widths
    ? [...widths].map(([id, width]) => `${id}:${Math.round(width / 10)}`).join('|')
    : null;
  useEffect(() => {
    // Not measured yet: keep whatever was asked for.
    if (!client || key === null) return;
    const timer = setTimeout(() => {
      const next = pickHighLayers(latest.current ?? new Map(), previous.current);
      previous.current = next;
      client.setHighLayers(next);
    }, LAYER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, key]);
  useEffect(
    () => () => {
      previous.current = new Set();
      client?.setHighLayers([]);
    },
    [client],
  );
}
