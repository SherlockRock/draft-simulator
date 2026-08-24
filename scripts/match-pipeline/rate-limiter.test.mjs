import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, SlidingWindowBucket, CompositeRateLimiter } from "./rate-limiter.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("TokenBucket starts full", () => {
  const b = new TokenBucket(5, 1000);
  assert.equal(b.available(), 5);
});

test("TokenBucket acquire while tokens available resolves immediately", async () => {
  const b = new TokenBucket(3, 1000);
  const start = Date.now();
  await b.acquire();
  await b.acquire();
  await b.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 20, `expected <20ms, got ${elapsed}ms`);
  assert.ok(b.available() < 1);
});

test("TokenBucket blocks when empty until refill", async () => {
  // 2 permits per 200ms = 1 permit per 100ms refill rate
  const b = new TokenBucket(2, 200);
  await b.acquire();
  await b.acquire();
  const start = Date.now();
  await b.acquire();
  const elapsed = Date.now() - start;
  // Should wait ~100ms for one token to refill
  assert.ok(elapsed >= 80, `expected >=80ms, got ${elapsed}ms`);
  assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`);
});

test("TokenBucket concurrent acquires serialize correctly", async () => {
  // 5 permits per 500ms — 6th request should wait ~100ms
  const b = new TokenBucket(5, 500);
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => b.acquire().then(() => Date.now() - start)),
  );
  // First 5 should complete near-instantly, 6th should wait
  const firstFive = results.slice(0, 5);
  const sixth = results[5];
  for (const t of firstFive) {
    assert.ok(t < 50, `expected first 5 fast, got ${t}ms`);
  }
  assert.ok(sixth >= 80, `expected 6th to wait, got ${sixth}ms`);
});

test("TokenBucket refills over time", async () => {
  const b = new TokenBucket(10, 1000); // 1 token per 100ms
  await b.acquire();
  await b.acquire();
  await b.acquire();
  const before = b.available();
  await sleep(150);
  // Force refill calculation by inspecting available()
  const after = b.available();
  assert.ok(after > before, `tokens should regenerate; before=${before} after=${after}`);
});

test("CompositeRateLimiter blocks on most-constrained bucket", async () => {
  const fast = new TokenBucket(100, 1000);
  const slow = new TokenBucket(2, 200); // 1 token / 100ms
  const composite = new CompositeRateLimiter([fast, slow]);

  await composite.acquire();
  await composite.acquire();
  // Now `slow` is empty — third acquire should block on slow even though fast has plenty
  const start = Date.now();
  await composite.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 80, `expected to wait on slow bucket, got ${elapsed}ms`);
});

test("CompositeRateLimiter consumes from every bucket", async () => {
  const a = new TokenBucket(5, 1000);
  const b = new TokenBucket(5, 1000);
  const composite = new CompositeRateLimiter([a, b]);
  await composite.acquire();
  await composite.acquire();
  // Both buckets should have decremented
  assert.ok(a.available() < 4);
  assert.ok(b.available() < 4);
});
// ---- SlidingWindowBucket (matches Riot's window-count semantics) ----

test("SlidingWindowBucket allows capacity requests instantly", async () => {
  const b = new SlidingWindowBucket(3, 500, { paddingMs: 0 });
  const start = Date.now();
  await b.acquire();
  await b.acquire();
  await b.acquire();
  assert.ok(Date.now() - start < 50);
});

test("SlidingWindowBucket blocks request capacity+1 until the window slides", async () => {
  const b = new SlidingWindowBucket(3, 300, { paddingMs: 0 });
  const start = Date.now();
  await b.acquire();
  await b.acquire();
  await b.acquire();
  await b.acquire(); // must wait for the first stamp to leave the window
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 280, `expected >=280ms, got ${elapsed}ms`);
});

test("SlidingWindowBucket never exceeds capacity in any window (no refill burst)", async () => {
  // The TokenBucket defect this class replaces: start-full + continuous refill
  // let ~2x capacity land inside one provider window at boot.
  const b = new SlidingWindowBucket(2, 200, { paddingMs: 0 });
  const times = [];
  for (let i = 0; i < 6; i++) {
    await b.acquire();
    times.push(Date.now());
  }
  for (let i = 0; i + 2 < times.length; i++) {
    const spread = times[i + 2] - times[i];
    assert.ok(spread >= 180, `requests ${i}..${i + 2} landed ${spread}ms apart (<180ms)`);
  }
});

test("SlidingWindowBucket padding widens the effective window", async () => {
  const b = new SlidingWindowBucket(1, 100, { paddingMs: 150 });
  const start = Date.now();
  await b.acquire();
  await b.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 230, `expected >=230ms, got ${elapsed}ms`);
});

test("SlidingWindowBucket works inside CompositeRateLimiter", async () => {
  const limiter = new CompositeRateLimiter([
    new SlidingWindowBucket(2, 150, { paddingMs: 0 }),
    new SlidingWindowBucket(10, 1000, { paddingMs: 0 }),
  ]);
  const start = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 130, `expected >=130ms, got ${elapsed}ms`);
});

test("SlidingWindowBucket.abort rejects a waiting acquire and every later one", async () => {
  const b = new SlidingWindowBucket(1, 60_000);
  await b.acquire(); // window now full for a minute
  const waiting = b.acquire();
  await sleep(10);
  b.abort();
  await assert.rejects(waiting, /rate-limiter aborted/);
  await assert.rejects(b.acquire(), /rate-limiter aborted/);
});

test("CompositeRateLimiter.abort forwards to every bucket", async () => {
  const a = new SlidingWindowBucket(1, 60_000);
  const c = new SlidingWindowBucket(5, 60_000);
  const limiter = new CompositeRateLimiter([a, c]);
  await limiter.acquire();
  const waiting = limiter.acquire(); // blocked on `a`
  await sleep(10);
  limiter.abort();
  await assert.rejects(waiting, /rate-limiter aborted/);
  await assert.rejects(c.acquire(), /rate-limiter aborted/);
});
