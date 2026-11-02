// SPDX-License-Identifier: AGPL-3.0-only
// Stream thumbnails: one private R2 object per live stream, written by
// the RoomDO when the helper uploads (PUT /api/rtc/rooms/:roomId/streams/:streamId/thumbnail) and
// served only by the Worker after a room access check (GET /api/streams/:streamId/thumbnail).

/** Largest upload accepted; the helper aims at 30 KB (320 px wide, JPEG quality ~70). */
export const THUMBNAIL_MAX_BYTES = 64 * 1024;
/** Shortest time between two stored thumbnails of a stream; the helper sends one every 10 s. */
export const THUMBNAIL_MIN_GAP_MS = 4_000;
/** The helper's header on the one upload it sends when the stream pauses (docs/PROTOCOL.md 11.3). */
export const THUMBNAIL_KIND_HEADER = 'X-Openlive-Thumbnail';
export const THUMBNAIL_PREFIX = 'thumbnails/';

export const thumbnailKey = (streamId: string): string => `${THUMBNAIL_PREFIX}${streamId}.jpg`;

/** The stream id of a thumbnail key, or null for anything else under the bucket. */
export function streamIdOfKey(key: string): string | null {
  const m = /^thumbnails\/([A-Za-z0-9_-]{1,64})\.jpg$/.exec(key);
  return m ? (m[1] ?? null) : null;
}

/** JPEG files start with the SOI marker and a segment marker (FF D8 FF). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
