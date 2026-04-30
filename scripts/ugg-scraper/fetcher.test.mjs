import { test } from "node:test";
import assert from "node:assert/strict";
import { UggFetcher } from "./fetcher.mjs";
import { TokenBucket } from "../match-pipeline/rate-limiter.mjs";

function stubFetch(scripts) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const s = scripts[i++];
    if (!s) throw new Error(`stub exhausted at call ${i}`);
    if (s.networkError) throw new Error(s.networkError);
    return new Response(JSON.stringify(s.body ?? null), { status: s.status });
  };
  fn.calls = calls;
  return fn;
}

const noWaitLimiter = () => new TokenBucket(1000, 1);

test("getJson returns parsed body on 200", async () => {
  const fetch = stubFetch([{ status: 200, body: { ok: 1 } }]);
  const f = new UggFetcher({ fetch, rateLimiter: noWaitLimiter() });
  assert.deepEqual(await f.getJson("https://x"), { ok: 1 });
});

test("getJson returns null on 404", async () => {
  const fetch = stubFetch([{ status: 404, body: {} }]);
  const f = new UggFetcher({ fetch, rateLimiter: noWaitLimiter() });
  assert.equal(await f.getJson("https://x"), null);
});

test("getJson returns null on 403 (non-real champion IDs)", async () => {
  const fetch = stubFetch([{ status: 403, body: {} }]);
  const f = new UggFetcher({ fetch, rateLimiter: noWaitLimiter() });
  assert.equal(await f.getJson("https://x"), null);
});

test("getJson retries on 503 and succeeds", async () => {
  const fetch = stubFetch([
    { status: 503, body: {} },
    { status: 200, body: { ok: 1 } },
  ]);
  const f = new UggFetcher({
    fetch,
    rateLimiter: noWaitLimiter(),
    backoffBaseMs: 1,
  });
  assert.deepEqual(await f.getJson("https://x"), { ok: 1 });
  assert.equal(fetch.calls.length, 2);
});

test("getJson retries on 429", async () => {
  const fetch = stubFetch([
    { status: 429, body: {} },
    { status: 200, body: { ok: 1 } },
  ]);
  const f = new UggFetcher({
    fetch,
    rateLimiter: noWaitLimiter(),
    backoffBaseMs: 1,
  });
  assert.deepEqual(await f.getJson("https://x"), { ok: 1 });
  assert.equal(fetch.calls.length, 2);
});

test("getJson throws on non-retryable 4xx", async () => {
  const fetch = stubFetch([{ status: 401, body: {} }]);
  const f = new UggFetcher({ fetch, rateLimiter: noWaitLimiter() });
  await assert.rejects(() => f.getJson("https://x"), /401/);
});

test("getJson retries on network error then throws", async () => {
  const fetch = stubFetch([
    { networkError: "ECONNRESET" },
    { networkError: "ECONNRESET" },
    { networkError: "ECONNRESET" },
    { networkError: "ECONNRESET" },
  ]);
  const f = new UggFetcher({
    fetch,
    rateLimiter: noWaitLimiter(),
    maxRetries: 3,
    backoffBaseMs: 1,
  });
  await assert.rejects(() => f.getJson("https://x"), /ECONNRESET/);
  assert.equal(fetch.calls.length, 4);
});
