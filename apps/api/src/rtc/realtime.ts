// SPDX-License-Identifier: AGPL-3.0-only
import type { IceServer, SessionDescription } from '@openlive/protocol';
import { REALTIME_API } from '../api/checks';

// The Cloudflare Realtime SFU and TURN HTTPS APIs. The Worker is
// their only client: the app token and the TURN key token stay here. Shapes and behaviour come
// from the Phase 0 proxies:
//
// - errors arrive at three levels: the HTTP status, a top-level errorCode, and an errorCode on
//   each track. Every call checks all three and throws SfuError on the first one found;
// - there is no "close session": tracks/close with force: true is how resources end;
// - TURN answers include URLs on port 53, which browsers block, so they are removed.
//
// Nothing here logs a token, an SDP or the SFU's free text; only codes and statuses.

export interface RealtimeConfig {
  appId: string;
  appToken: string;
  /** Absent: viewers and helpers get STUN only. */
  turn: { keyId: string; keyToken: string } | null;
}

export function realtimeConfig(env: Env): RealtimeConfig | null {
  const appId = env.REALTIME_APP_ID?.trim();
  const appToken = env.REALTIME_APP_TOKEN?.trim();
  if (!appId || !appToken) return null;
  const keyId = env.TURN_KEY_ID?.trim();
  const keyToken = env.TURN_KEY_TOKEN?.trim();
  return { appId, appToken, turn: keyId && keyToken ? { keyId, keyToken } : null };
}

/** The SFU refused a call. `sfuCode` is the SFU's errorCode, when it sent one. */
export class SfuError extends Error {
  constructor(
    readonly level: 'http' | 'body' | 'track',
    readonly status: number,
    readonly sfuCode: string | null,
  ) {
    super(`sfu ${level} error ${status} ${sfuCode ?? ''}`.trim());
  }
}

export interface SimulcastPreference {
  preferredRid: string;
  priorityOrdering: 'none' | 'asciibetical';
  ridNotAvailable: 'none' | 'asciibetical';
}

/** A track object of the Realtime API, as sent and as returned. */
export interface SfuTrack {
  location?: 'local' | 'remote';
  mid?: string;
  trackName?: string;
  sessionId?: string;
  simulcast?: SimulcastPreference;
  errorCode?: string;
  errorDescription?: string;
}

export interface SfuResponse {
  sessionId?: string;
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: SfuTrack[];
  errorCode?: string;
  errorDescription?: string;
}

/** The SFU takes 1 to 4 tracks per request. */
export const TRACKS_PER_REQUEST = 4;

const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const TURN_TTL_S = 4 * 60 * 60;

/** Browsers block port 53; drop those URLs so ICE does not wait on them (Phase 0, P1). */
function withoutPort53(urls: string[]): string[] {
  return urls.filter((u) => !/:53(\?|$)/.test(u));
}

export class Realtime {
  constructor(
    private readonly config: RealtimeConfig,
    // Looked up at call time, so tests can replace the global fetch.
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<SfuResponse> {
    const res = await this.fetchFn(`${REALTIME_API}/apps/${this.config.appId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.appToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: SfuResponse = {};
    try {
      json = text ? (JSON.parse(text) as SfuResponse) : {};
    } catch {
      // Not JSON: only the status says anything.
    }
    const op = path.replace(/\/sessions\/[^/]+/, '/sessions/:id');
    if (!res.ok || json.errorCode) {
      const level = res.ok ? 'body' : 'http';
      console.warn(`sfu ${method} ${op}: ${level} ${res.status} ${json.errorCode ?? ''}`);
      throw new SfuError(level, res.status, json.errorCode ?? null);
    }
    const failed = json.tracks?.find((t) => t.errorCode);
    if (failed) {
      console.warn(`sfu ${method} ${op}: track ${failed.errorCode ?? ''}`);
      throw new SfuError('track', res.status, failed.errorCode ?? null);
    }
    return json;
  }

  /** sessions/new; with an offer the answer comes back too. */
  async newSession(offer?: SessionDescription): Promise<SfuResponse & { sessionId: string }> {
    const res = await this.call(
      'POST',
      '/sessions/new',
      offer ? { sessionDescription: offer } : undefined,
    );
    if (!res.sessionId) throw new SfuError('body', 200, null);
    return { ...res, sessionId: res.sessionId };
  }

  newTracks(
    sessionId: string,
    tracks: SfuTrack[],
    sessionDescription?: SessionDescription,
  ): Promise<SfuResponse> {
    return this.call('POST', `/sessions/${sessionId}/tracks/new`, {
      ...(sessionDescription ? { sessionDescription } : {}),
      tracks,
    });
  }

  renegotiate(sessionId: string, sessionDescription: SessionDescription): Promise<SfuResponse> {
    return this.call('PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription });
  }

  /** Changes existing subscriptions in place (simulcast layer), no renegotiation. */
  updateTracks(sessionId: string, tracks: SfuTrack[]): Promise<SfuResponse> {
    return this.call('PUT', `/sessions/${sessionId}/tracks/update`, { tracks });
  }

  /** tracks/close with force: no SDP exchange; the only way to end SFU resources. */
  closeTracks(sessionId: string, mids: string[]): Promise<SfuResponse> {
    return this.call('PUT', `/sessions/${sessionId}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      force: true,
    });
  }

  /**
   * Short-lived STUN and TURN servers, tagged with `customIdentifier` (the space id) so TURN
   * usage can be attributed. Falls back to STUN only when TURN is not configured or refuses.
   */
  async iceServers(customIdentifier: string): Promise<IceServer[]> {
    const turn = this.config.turn;
    if (!turn) return STUN_ONLY;
    let res: Response;
    try {
      res = await this.fetchFn(
        `${REALTIME_API}/turn/keys/${turn.keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${turn.keyToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TURN_TTL_S, customIdentifier }),
        },
      );
    } catch {
      console.warn('turn generate-ice-servers: unreachable');
      return STUN_ONLY;
    }
    if (!res.ok) {
      await res.body?.cancel();
      console.warn(`turn generate-ice-servers: http ${res.status}`);
      return STUN_ONLY;
    }
    type Raw = { urls: string | string[]; username?: string; credential?: string };
    const json = (await res.json()) as { iceServers?: Raw | Raw[] };
    const raw = json.iceServers;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: IceServer[] = [];
    for (const s of list) {
      const urls = withoutPort53(Array.isArray(s.urls) ? s.urls : [s.urls]);
      if (urls.length === 0) continue;
      out.push({
        urls,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      });
    }
    return out.length > 0 ? out : STUN_ONLY;
  }
}

/** Splits mids into requests of at most TRACKS_PER_REQUEST. */
export function chunks<T>(items: T[], size = TRACKS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
