// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-key token buckets: `ratePerS` tokens per second up to `burst` (docs/PROTOCOL.md 7.9). Keys
 * whose bucket is full again are forgotten, so the map stays as small as the active senders.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerS: number,
    private readonly burst: number,
  ) {}

  /** Takes one token: 0 when allowed, else the milliseconds until the next token. */
  take(key: string, now: number): number {
    const prev = this.buckets.get(key);
    const tokens = prev
      ? Math.min(this.burst, prev.tokens + ((now - prev.at) / 1000) * this.ratePerS)
      : this.burst;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil(((1 - tokens) / this.ratePerS) * 1000));
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > 256) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.ratePerS >= this.burst) this.buckets.delete(key);
    }
  }
}
