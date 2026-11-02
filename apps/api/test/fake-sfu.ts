// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';

// A fake Cloudflare Realtime SFU and TURN API behind a replaced global fetch. The response shapes
// are the ones the Phase 0 proxies saw (publish, join, tracks/update): sessions/new answers 201 { sessionId } (plus the answer when given an offer); a
// local tracks/new answers the offer; a remote pull returns requiresImmediateRenegotiation with an
// offer; tracks/close and tracks/update return the tracks. Responses are created per call, inside
// the Durable Object that fetches (workerd refuses I/O objects made in another context).

export const SFU_APP = 'https://rtc.live.cloudflare.com/v1/apps/test-app';
export const TURN_URL =
  'https://rtc.live.cloudflare.com/v1/turn/keys/test-turn-key/credentials/generate-ice-servers';

export interface SfuCall {
  method: string;
  /** Path below /apps/test-app, with the session id kept. */
  path: string;
  /** The operation with ":id" for the session: "PUT /sessions/:id/tracks/close". */
  op: string;
  sessionId: string | null;
  // Bodies are checked field by field in the tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  authorization: string | null;
  startedAt: number;
  endedAt: number;
}

export interface FakeSfuOptions {
  /** Return this instead of the normal answer for an operation ("POST /sessions/new", ...). */
  override?: (call: SfuCall) => Response | null;
  /** Delay of every SFU answer, to observe serialization. */
  delayMs?: number;
}

const sdp = (type: 'offer' | 'answer', n: number) => ({
  type,
  sdp: `v=0\r\no=- ${n} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n`,
});

export class FakeSfu {
  readonly calls: SfuCall[] = [];
  readonly turnCalls: { body: unknown; authorization: string | null }[] = [];
  private sessions = 0;
  private readonly nextMid = new Map<string, number>();

  constructor(private readonly options: FakeSfuOptions = {}) {}

  install(): this {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      if (url === TURN_URL) {
        this.turnCalls.push({
          body: JSON.parse(String(init?.body)),
          authorization: headers.get('Authorization'),
        });
        return Response.json({
          iceServers: [
            {
              urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'],
            },
            {
              urls: [
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turn:turn.cloudflare.com:53?transport=udp',
                'turns:turn.cloudflare.com:443?transport=tcp',
              ],
              username: 'turn-user',
              credential: 'turn-credential',
            },
          ],
        });
      }
      if (!url.startsWith(SFU_APP)) throw new Error(`unexpected fetch to ${url}`);
      const path = url.slice(SFU_APP.length);
      const sessionId = /^\/sessions\/([^/]+)/.exec(path)?.[1] ?? null;
      const call: SfuCall = {
        method: init?.method ?? 'GET',
        path,
        op: `${init?.method ?? 'GET'} ${sessionId && sessionId !== 'new' ? path.replace(sessionId, ':id') : path}`,
        sessionId: sessionId === 'new' ? null : sessionId,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get('Authorization'),
        startedAt: Date.now(),
        endedAt: 0,
      };
      this.calls.push(call);
      if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
      const res = this.options.override?.(call) ?? this.answer(call);
      call.endedAt = Date.now();
      return res;
    });
    return this;
  }

  private mid(sessionId: string): string {
    const n = this.nextMid.get(sessionId) ?? 0;
    this.nextMid.set(sessionId, n + 1);
    return String(n);
  }

  private answer(call: SfuCall): Response {
    const n = this.calls.length;
    switch (call.op) {
      case 'POST /sessions/new': {
        this.sessions += 1;
        const sessionId = this.sessions.toString(16).padStart(64, 'a');
        return Response.json(
          {
            sessionId,
            ...(call.body?.sessionDescription ? { sessionDescription: sdp('answer', n) } : {}),
          },
          { status: 201 },
        );
      }
      case 'POST /sessions/:id/tracks/new': {
        const tracks = call.body.tracks as { location: string; mid?: string; trackName: string }[];
        const remote = tracks.some((t) => t.location === 'remote');
        return Response.json({
          requiresImmediateRenegotiation: remote,
          sessionDescription: sdp(remote ? 'offer' : 'answer', n),
          tracks: tracks.map((t) => ({
            trackName: t.trackName,
            mid: remote ? this.mid(call.sessionId ?? '') : t.mid,
            ...(remote ? { sessionId: (t as { sessionId?: string }).sessionId } : {}),
          })),
        });
      }
      case 'PUT /sessions/:id/renegotiate':
        return Response.json(
          call.body.sessionDescription.type === 'offer'
            ? { sessionDescription: sdp('answer', n) }
            : {},
        );
      case 'PUT /sessions/:id/tracks/update':
        return Response.json({ requiresImmediateRenegotiation: false, tracks: call.body.tracks });
      case 'PUT /sessions/:id/tracks/close':
        return Response.json({
          requiresImmediateRenegotiation: false,
          tracks: (call.body.tracks as { mid: string }[]).map((t) => ({ mid: t.mid })),
        });
    }
    return Response.json({ errorCode: 'not_found' }, { status: 404 });
  }

  /**
   * Waits until `count` calls of `op` were made. Cleanup calls run at the end of a room event and
   * may wait for the per-session spacing (rtc/queue.ts), so they can land after the reply.
   */
  async until(op: string, count: number): Promise<SfuCall[]> {
    const deadline = Date.now() + 2_000;
    while (this.of(op).length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} × ${op}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.of(op);
  }

  /** Calls of one operation, in order. */
  of(op: string): SfuCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

export const offer = sdp('offer', 1);
export const answer = sdp('answer', 2);
