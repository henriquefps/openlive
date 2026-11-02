// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, StreamInfo } from '@openlive/protocol';

// "Allow visual clicks" in the Go live panel (docs/PROTOCOL.md 7.9). The panel runs before the
// stream exists, and only the stream's announce says whether the helper can draw pings
// (pingOverlay). So the choice waits here, by room and helper, until this user's stream from that
// helper shows up in the room: then it is applied when the helper can draw, and dropped
// silently when it cannot.

/** Helpers that may draw pings: protocol 1.20 and up, and not macOS for now. */
export function helperMayPing(helper: Pick<HelperInfo, 'os' | 'protocol'> | undefined): boolean {
  if (!helper || helper.os === 'macos') return false;
  const { major, minor } = helper.protocol;
  return major > 1 || (major === 1 && minor >= 20);
}

const intents = new Set<string>();
const keyOf = (roomId: string, deviceId: string) => `${roomId}\n${deviceId}`;

export const pingsIntent = {
  set(roomId: string, deviceId: string, allow: boolean): void {
    if (allow) intents.add(keyOf(roomId, deviceId));
    else intents.delete(keyOf(roomId, deviceId));
  },
  has(roomId: string, deviceId: string): boolean {
    return intents.has(keyOf(roomId, deviceId));
  },
  /**
   * The streams of `selfId` whose waiting choice is due now; their choices are taken (each
   * applies once). Only the streams that can be turned on are returned.
   */
  due(roomId: string, selfId: string, streams: readonly StreamInfo[]): StreamInfo[] {
    const out: StreamInfo[] = [];
    for (const s of streams) {
      if (s.userId !== selfId || !intents.delete(keyOf(roomId, s.deviceId))) continue;
      if (s.pingOverlay && !s.pings) out.push(s);
    }
    return out;
  },
};
