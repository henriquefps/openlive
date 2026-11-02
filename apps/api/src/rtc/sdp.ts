// SPDX-License-Identifier: AGPL-3.0-only
// The little SDP reading the Worker needs. It never rewrites an SDP: the SFU gets the client's
// text as is.

/** The lines of the m-section with this mid, if any. */
function sectionOfMid(sdp: string, mid: string): string[] | null {
  for (const section of sdp.split(/\r?\n(?=m=)/).slice(1)) {
    const lines = section.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(`a=mid:${mid}`)) return lines;
  }
  return null;
}

/** The media kind (`audio`, `video`, `application`) of the m-section with this mid, if any. */
export function mediaKindOfMid(sdp: string, mid: string): string | null {
  const lines = sectionOfMid(sdp, mid);
  return lines ? (/^m=([a-z]+) /.exec(lines[0] ?? '')?.[1] ?? null) : null;
}

/**
 * The simulcast layers an m-section sends, in the order of its `a=simulcast:send` line (the
 * order of the browser's sendEncodings, highest first), else of its `a=rid:<id> send` lines.
 * Empty when it is not simulcast; null when the mid is not in the SDP.
 */
export function sendRidsOfMid(sdp: string, mid: string): string[] | null {
  const lines = sectionOfMid(sdp, mid);
  if (!lines) return null;
  const simulcast = lines.find((l) => l.startsWith('a=simulcast:'));
  const send = simulcast ? /(?:^a=simulcast:|\s)send\s+(\S+)/.exec(simulcast)?.[1] : undefined;
  if (send) {
    // `h;l`, with `~` marking a paused layer and `,` alternatives (the first one is kept).
    return send.split(';').map((alt) => (alt.split(',')[0] ?? '').replace(/^~/, ''));
  }
  return lines.flatMap((l) => {
    const rid = /^a=rid:(\S+)\s+send\b/.exec(l)?.[1];
    return rid ? [rid] : [];
  });
}
