import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, CompositeRateLimiter } from "./rate-limiter.mjs";

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
