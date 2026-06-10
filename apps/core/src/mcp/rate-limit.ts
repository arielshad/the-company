/**
 * Per-principal rate limiting for the MCP front door (FR-7.4).
 *
 * A simple, real in-memory token bucket keyed by principal id. Each principal
 * gets `capacity` tokens that refill at `refillPerSec`; a `tools/call` consumes
 * one. When the bucket is empty the call is rejected (the caller maps this to an
 * MCP error). In-memory is intentional for the MVP single-instance monolith; a
 * shared store (Redis) is the natural swap for the horizontally-scaled gateway
 * called out in ADR-0006, behind this same interface.
 */
export interface RateLimitConfig {
  /** Max burst — tokens available when full. */
  capacity: number;
  /** Steady-state refill rate (tokens per second). */
  refillPerSec: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  capacity: 30,
  refillPerSec: 10
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: Partial<RateLimitConfig> = {}, private now: () => number = Date.now) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
  }

  /**
   * Attempt to consume one token for `key`. Returns true if allowed, false if
   * the principal is currently over their limit.
   */
  tryConsume(key: string, cost = 1): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.capacity, updatedAt: t };
      this.buckets.set(key, bucket);
    }
    // Refill based on elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, (t - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSec);
    bucket.updatedAt = t;

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }
}
