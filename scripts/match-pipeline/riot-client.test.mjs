import { test } from "node:test";
import assert from "node:assert/strict";
import { RiotClient } from "./riot-client.mjs";
import { TokenBucket, CompositeRateLimiter } from "./rate-limiter.mjs";

/**
 * Build a stub fetch that returns scripted responses in order.
 * Each script entry is `{ status, body, headers? }` or a function that
 * receives `(url, init)` and returns the response.
 */
function stubFetch(scripts) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const script = scripts[i++];
    if (!script) throw new Error(`stubFetch ran out of scripts at call ${i}`);
    const { status, body, headers = {} } = typeof script === "function" ? script(url, init) : script;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  fn.calls = calls;
  return fn;
}

const noopSleep = async () => {};

test("get() sends X-Riot-Token header", async () => {
  const fetch = stubFetch([{ status: 200, body: { ok: true } }]);
  const client = new RiotClient({ apiKey: "RGAPI-test", fetch, sleep: noopSleep });
  await client.get("/lol/test", { routing: "platform", region: "na1" });
  assert.equal(fetch.calls[0].init.headers["X-Riot-Token"], "RGAPI-test");
});

test("get() routes via platform host", async () => {
  const fetch = stubFetch([{ status: 200, body: {} }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.get("/lol/foo", { routing: "platform", region: "na1" });
  assert.match(fetch.calls[0].url, /^https:\/\/na1\.api\.riotgames\.com\/lol\/foo/);
});

test("get() routes via continent host", async () => {
  const fetch = stubFetch([{ status: 200, body: {} }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.get("/lol/match/v5/x", { routing: "continent", region: "americas" });
  assert.match(fetch.calls[0].url, /^https:\/\/americas\.api\.riotgames\.com\/lol\/match/);
});

test("get() returns parsed JSON on 200", async () => {
  const fetch = stubFetch([{ status: 200, body: { foo: 42 } }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  const result = await client.get("/x", { routing: "platform", region: "na1" });
  assert.deepEqual(result, { foo: 42 });
});

test("get() retries on 429 with Retry-After", async () => {
  const fetch = stubFetch([
    { status: 429, body: {}, headers: { "retry-after": "1" } },
    { status: 200, body: { ok: true } },
  ]);
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const client = new RiotClient({ apiKey: "k", fetch, sleep });
  const result = await client.get("/x", { routing: "platform", region: "na1" });
  assert.deepEqual(result, { ok: true });
  assert.equal(fetch.calls.length, 2);
  assert.equal(sleeps[0], 1000); // 1s in ms
});

test("get() retries on 5xx with exponential backoff", async () => {
  const fetch = stubFetch([
    { status: 503, body: {} },
    { status: 503, body: {} },
    { status: 200, body: { ok: true } },
  ]);
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  const client = new RiotClient({
    apiKey: "k",
    fetch,
    sleep,
    backoffBaseMs: 100,
  });
  const result = await client.get("/x", { routing: "platform", region: "na1" });
  assert.deepEqual(result, { ok: true });
  assert.equal(fetch.calls.length, 3);
  // First backoff ~100ms, second ~200ms (with some jitter)
  assert.ok(sleeps[0] >= 100 && sleeps[0] < 200, `first sleep ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 200 && sleeps[1] < 400, `second sleep ${sleeps[1]}`);
});

test("get() throws on 4xx (non-429) immediately", async () => {
  const fetch = stubFetch([{ status: 404, body: { status: { message: "Not found" } } }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await assert.rejects(
    () => client.get("/missing", { routing: "platform", region: "na1" }),
    /404/,
  );
  assert.equal(fetch.calls.length, 1);
});

test("get() throws on 401 (bad key) immediately", async () => {
  const fetch = stubFetch([{ status: 401, body: {} }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await assert.rejects(
    () => client.get("/x", { routing: "platform", region: "na1" }),
    /401/,
  );
  assert.equal(fetch.calls.length, 1);
});

test("get() gives up after maxRetries 5xx responses", async () => {
  const fetch = stubFetch(Array.from({ length: 6 }, () => ({ status: 503, body: {} })));
  const client = new RiotClient({
    apiKey: "k",
    fetch,
    sleep: noopSleep,
    maxRetries: 3,
    backoffBaseMs: 1,
  });
  await assert.rejects(
    () => client.get("/x", { routing: "platform", region: "na1" }),
    /503/,
  );
  // Initial attempt + 3 retries = 4 calls
  assert.equal(fetch.calls.length, 4);
});

test("get() acquires rate limiter once per attempt", async () => {
  const fetch = stubFetch([
    { status: 429, body: {}, headers: { "retry-after": "0" } },
    { status: 200, body: {} },
  ]);
  const bucket = new TokenBucket(10, 1000);
  const limiter = new CompositeRateLimiter([bucket]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep, rateLimiter: limiter });
  const before = bucket.available();
  await client.get("/x", { routing: "platform", region: "na1" });
  const after = bucket.available();
  // Should have decremented by ~2 (one per attempt: original + retry)
  assert.ok(before - after >= 1.9, `expected ~2 tokens consumed, got ${before - after}`);
});

test("get() builds query string from query object", async () => {
  const fetch = stubFetch([{ status: 200, body: [] }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.get("/lol/test", {
    routing: "continent",
    region: "americas",
    query: { count: 100, queue: 420 },
  });
  assert.match(fetch.calls[0].url, /\?count=100&queue=420$/);
});

test("getMatch() calls Match-V5 endpoint", async () => {
  const fetch = stubFetch([{ status: 200, body: { matchId: "NA1_1" } }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.getMatch("NA1_5012345678", "americas");
  assert.match(
    fetch.calls[0].url,
    /^https:\/\/americas\.api\.riotgames\.com\/lol\/match\/v5\/matches\/NA1_5012345678$/,
  );
});

test("getMatchIdsByPuuid() builds correct URL with query params", async () => {
  const fetch = stubFetch([{ status: 200, body: [] }]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.getMatchIdsByPuuid("PUUID-x", "americas", { queue: 420, count: 50 });
  const url = fetch.calls[0].url;
  assert.match(url, /by-puuid\/PUUID-x\/ids/);
  assert.match(url, /queue=420/);
  assert.match(url, /count=50/);
});

test("getApexEntries() calls correct league endpoint per tier", async () => {
  const fetch = stubFetch([
    { status: 200, body: { entries: [] } },
    { status: 200, body: { entries: [] } },
    { status: 200, body: { entries: [] } },
  ]);
  const client = new RiotClient({ apiKey: "k", fetch, sleep: noopSleep });
  await client.getApexEntries({ tier: "CHALLENGER", queue: "RANKED_SOLO_5x5", platform: "na1" });
  await client.getApexEntries({ tier: "GRANDMASTER", queue: "RANKED_SOLO_5x5", platform: "na1" });
  await client.getApexEntries({ tier: "MASTER", queue: "RANKED_SOLO_5x5", platform: "na1" });
  assert.match(fetch.calls[0].url, /challengerleagues\/by-queue\/RANKED_SOLO_5x5/);
  assert.match(fetch.calls[1].url, /grandmasterleagues\/by-queue\/RANKED_SOLO_5x5/);
  assert.match(fetch.calls[2].url, /masterleagues\/by-queue\/RANKED_SOLO_5x5/);
});
