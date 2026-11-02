// SPDX-License-Identifier: AGPL-3.0-only
// Lip sync: the SFU puts every pulled track in its own msid stream, and browsers only
// synchronise audio with video inside one stream. Before setRemoteDescription, the viewer rewrites
// the SFU's offer so each stream's audio joins its video's msid stream: audio goes from +72 ms late
// to −5 ms, for about 60 ms more video latency.

/** An audio m-section that must play in sync with a video m-section, both named by `a=mid`. */
export interface MsidPair {
  video: string;
  audio: string;
}

interface Section {
  kind: string;
  mid: string | null;
  /** The stream id of its `a=msid:<stream> <track>` line. */
  stream: string | null;
  lines: string[];
}

function split(sdp: string): { eol: string; session: string[]; sections: Section[] } {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  if (lines.at(-1) === '') lines.pop();
  const session: string[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      sections.push({
        kind: line.slice(2).split(' ')[0] ?? '',
        mid: null,
        stream: null,
        lines: [],
      });
    }
    const current = sections.at(-1);
    if (!current) {
      session.push(line);
      continue;
    }
    current.lines.push(line);
    if (line.startsWith('a=mid:')) current.mid = line.slice('a=mid:'.length).trim();
    const msid = /^a=msid:(\S+)/.exec(line);
    if (msid?.[1]) current.stream = msid[1];
  }
  return { eol, session, sections };
}

/**
 * Moves each pair's audio into its video's msid stream. Without `pairs`, an offer with one video
 * section gets every audio section joined to it (the first case); with several videos (one SFU
 * session carrying more than one stream) the caller must say which audio goes with which video,
 * from the mids that tracks/new returned. Unknown mids and sections without msid are left alone.
 */
export function joinMsidStreams(sdp: string, pairs?: readonly MsidPair[]): string {
  const { eol, session, sections } = split(sdp);
  const videos = sections.filter((s) => s.kind === 'video' && s.stream && s.mid !== null);
  const resolved: readonly MsidPair[] =
    pairs ??
    (videos.length === 1 && videos[0]?.mid
      ? sections
          .filter((s) => s.kind === 'audio' && s.mid !== null)
          .map((s) => ({ video: videos[0]?.mid ?? '', audio: s.mid ?? '' }))
      : []);
  let changed = false;
  for (const pair of resolved) {
    const video = sections.find((s) => s.kind === 'video' && s.mid === pair.video);
    const audio = sections.find((s) => s.kind === 'audio' && s.mid === pair.audio);
    if (!video?.stream || !audio?.stream || audio.stream === video.stream) continue;
    const from = audio.stream;
    const to = video.stream;
    audio.lines = audio.lines.map((line) => {
      if (line.startsWith(`a=msid:${from} `))
        return `a=msid:${to} ${line.slice(`a=msid:${from} `.length)}`;
      // Offers with ssrc attributes repeat the msid there (a=ssrc:<ssrc> msid:<stream> <track>).
      return line.replace(new RegExp(`^(a=ssrc:\\d+ msid:)${escape(from)}( |$)`), `$1${to}$2`);
    });
    audio.stream = to;
    changed = true;
  }
  if (!changed) return sdp;

  // The session-level stream list must name the streams that are left, in first-use order.
  const streams = [...new Set(sections.map((s) => s.stream).filter((s): s is string => !!s))];
  const head = session.map((line) =>
    /^a=msid-semantic: ?WMS\b/.test(line)
      ? `${line.slice(0, line.indexOf('WMS') + 3)} ${streams.join(' ')}`
      : line,
  );
  return [...head, ...sections.flatMap((s) => s.lines)].join(eol) + eol;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
