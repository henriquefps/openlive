// SPDX-License-Identifier: AGPL-3.0-only
// Per-SFU-session serialization: calls that change one SFU session run
// one at a time, in order, and start at least MIN_GAP_MS apart, which keeps a session under the
// SFU's 50 requests per second. The RoomDO owns its room's sessions and is a single instance, so
// an in-memory chain is authoritative; a hibernated DO has nothing in flight to lose.

/** 1000 ms / 50 requests. */
export const MIN_GAP_MS = 20;

export class SessionQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();

  constructor(private readonly minGapMs = MIN_GAP_MS) {}

  run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.lastStart.get(sessionId) ?? 0) + this.minGapMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.lastStart.set(sessionId, Date.now());
        return fn();
      });
    this.tails.set(sessionId, next);
    void next
      .finally(() => {
        if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
        // Start times only matter for MIN_GAP_MS; forget the old ones.
        const old = Date.now() - this.minGapMs;
        for (const [id, t] of this.lastStart) if (t < old) this.lastStart.delete(id);
      })
      .catch(() => undefined);
    return next;
  }
}
