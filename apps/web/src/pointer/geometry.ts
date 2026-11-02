// SPDX-License-Identifier: AGPL-3.0-only

// Where a click lands on the video frame (docs/PROTOCOL.md 7.9: x and y from 0 to 1 over the
// frame). The player's <video> is `object-contain`: the frame is scaled to fit and centred, with
// black bars on the sides or on top and bottom. Clicks on the bars are not on the frame.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The frame's box inside an element of `box` size showing a `videoWidth` × `videoHeight` frame
 * with object-fit: contain, relative to the element. Without a known frame size (no metadata
 * yet) the frame fills the element.
 */
export function frameBox(
  box: { width: number; height: number },
  videoWidth: number,
  videoHeight: number,
): Box {
  if (videoWidth <= 0 || videoHeight <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: 0, top: 0, width: box.width, height: box.height };
  }
  const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * A point in the element (`px`, `py` from its top left) as 0..1 over the frame, or null when it
 * falls on the black bars or outside.
 */
export function framePoint(
  px: number,
  py: number,
  box: { width: number; height: number },
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } | null {
  const frame = frameBox(box, videoWidth, videoHeight);
  if (frame.width <= 0 || frame.height <= 0) return null;
  const x = (px - frame.left) / frame.width;
  const y = (py - frame.top) / frame.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** A 0..1 frame point back to percentages of the element, to place a marker over it. */
export function elementPercent(
  point: { x: number; y: number },
  box: { width: number; height: number },
  videoWidth: number,
  videoHeight: number,
): { left: number; top: number } {
  const frame = frameBox(box, videoWidth, videoHeight);
  if (box.width <= 0 || box.height <= 0) return { left: point.x * 100, top: point.y * 100 };
  return {
    left: ((frame.left + point.x * frame.width) / box.width) * 100,
    top: ((frame.top + point.y * frame.height) / box.height) * 100,
  };
}
