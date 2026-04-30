/**
 * Rate limiting primitives for the Riot API client.
 *
 * Riot enforces two simultaneous limits per request:
 *   - App tier   (e.g. 100 req / 2 min on a personal key)
 *   - Method tier (varies per endpoint, lower than app tier)
 *
 * A `CompositeRateLimiter` wrapping two `TokenBucket`s captures both.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TokenBucket {
  /**
   * @param {number} capacity      max tokens (also the burst limit)
   * @param {number} windowMs      time over which capacity tokens regenerate
   */
  constructor(capacity, windowMs) {
    if (capacity <= 0 || windowMs <= 0) {
      throw new Error("capacity and windowMs must be positive");
    }
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerMs = capacity / windowMs;
    this.lastRefill = Date.now();
    // Promise chain to serialize concurrent acquires.
    this.tail = Promise.resolve();
  }

  #refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
      this.lastRefill = now;
    }
  }

  available() {
    this.#refill();
    return this.tokens;
  }

  acquire() {
    const next = this.tail.then(async () => {
      this.#refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillRatePerMs);
      await sleep(waitMs);
      this.#refill();
      this.tokens -= 1;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}

export class CompositeRateLimiter {
  /**
   * @param {TokenBucket[]} buckets  every bucket must yield a token before acquire() resolves
   */
  constructor(buckets) {
    if (!Array.isArray(buckets) || buckets.length === 0) {
      throw new Error("CompositeRateLimiter requires at least one bucket");
    }
    this.buckets = buckets;
  }

  async acquire() {
    // Sequential acquire. We slightly over-block (holding token from bucket[0]
    // while waiting on bucket[1]) but Riot's two limits are correlated in practice
    // — if you're hitting the per-method limit you're usually fine on the per-app
    // limit anyway, so the over-block is rarely observed.
    for (const bucket of this.buckets) {
      await bucket.acquire();
    }
  }
}
