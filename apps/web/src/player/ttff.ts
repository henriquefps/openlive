// SPDX-License-Identifier: AGPL-3.0-only
// Time to first frame (under 1 s), measured in the page: from the click on a stream card
// to the first frame the video element presents (requestVideoFrameCallback). The room view marks
// the click; the player reads the mark when it mounts and shows the result in stats for nerds.

const starts = new Map<string, number>();

/** A stream was clicked (or opened some other way) at `at` (performance.now()). */
export function markWatchStart(streamId: string, at: number = performance.now()): void {
  starts.set(streamId, at);
}

/** When watching this stream started, if the room view marked it. */
export function watchStartOf(streamId: string): number | null {
  return starts.get(streamId) ?? null;
}
