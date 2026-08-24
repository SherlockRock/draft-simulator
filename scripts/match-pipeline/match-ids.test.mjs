import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { upsertSummoners, insertPendingMatches } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { makeTestDb, silentLogger } from "./test-support.mjs";
import { runMatchIdCycle } from "./match-ids.mjs";

let db;

before(async () => {
  db = await makeTestDb("fp_collector_matchids_test");
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE summoners, matches");
});

/**
 * Mock client keyed by puuid: `idPages[puuid]` is an array of pages (arrays of
 * match ids) served in order of the `start` offset. A value of "400" throws a
 * Riot 400; "boom" throws a generic error.
 */
function mockClient(idPages) {
  const calls = [];
  return {
    calls,
    async getMatchIdsByPuuid(puuid, continent, opts) {
      calls.push({ puuid, continent, opts });
      const pages = idPages[puuid];
      if (pages === "400") throw new Error("Riot API 400 from https://x: bad request");
      if (pages === "boom") throw new Error("ECONNRESET");
      const pageIndex = Math.floor((opts.start ?? 0) / opts.count);
      return pages?.[pageIndex] ?? [];
    },
  };
}

const seedSummoner = (db, region, puuid, tier, division = "I") =>
  upsertSummoners(db, region, [{ puuid, tier, division, leaguePoints: 100 }]);

test("discovers ids, inserts pending rows with seed rank, stamps the summoner", async () => {
  await seedSummoner(db, "na1", "P1", "DIAMOND", "II");
  const client = mockClient({ P1: [["NA1_1", "NA1_2"]] });
  const config = loadConfig({});
  const result = await runMatchIdCycle({ client, db, config, region: "na1", logger: silentLogger });

  assert.deepEqual(result, { paused: false, summonersProcessed: 1, discovered: 2 });
  const { rows } = await db.query("SELECT * FROM matches ORDER BY match_id");
  assert.deepEqual(
    rows.map((r) => [r.match_id, r.status, r.seed_tier, r.seed_division]),
    [
      ["NA1_1", "pending", "DIAMOND", "II"],
      ["NA1_2", "pending", "DIAMOND", "II"],
    ],
  );
  const [s] = (await db.query("SELECT matches_fetched_at FROM summoners")).rows;
  assert.ok(s.matches_fetched_at instanceof Date);
  // Continent routing + crawl filters on the request
  assert.equal(client.calls[0].continent, "americas");
  assert.equal(client.calls[0].opts.queue, 420);
  assert.equal(client.calls[0].opts.startTime, config.startTime);
  assert.equal(client.calls[0].opts.count, 100);
});

test("two summoners sharing a match id produce one row", async () => {
  await seedSummoner(db, "na1", "P1", "MASTER");
  await seedSummoner(db, "na1", "P2", "DIAMOND");
  const client = mockClient({ P1: [["NA1_1"]], P2: [["NA1_1", "NA1_2"]] });
  const result = await runMatchIdCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.equal(result.discovered, 2);
  const { rows } = await db.query("SELECT match_id, seed_tier FROM matches ORDER BY match_id");
  assert.deepEqual(
    rows.map((r) => [r.match_id, r.seed_tier]),
    [
      ["NA1_1", "MASTER"], // apex-first ordering means P1 seeded it
      ["NA1_2", "DIAMOND"],
    ],
  );
});

test("apex summoners page up to apexMatchIdPages; Diamond gets one page", async () => {
  await seedSummoner(db, "na1", "APEX", "CHALLENGER");
  await seedSummoner(db, "na1", "DIA", "DIAMOND");
  const fullPage = (prefix) => Array.from({ length: 100 }, (_, i) => `${prefix}_${i}`);
  const client = mockClient({
    APEX: [fullPage("NA1_A0"), fullPage("NA1_A1"), fullPage("NA1_A2"), fullPage("NA1_A3")],
    DIA: [fullPage("NA1_D0"), fullPage("NA1_D1")],
  });
  await runMatchIdCycle({ client, db, config: loadConfig({}), region: "na1", logger: silentLogger });

  const apexCalls = client.calls.filter((c) => c.puuid === "APEX");
  const diaCalls = client.calls.filter((c) => c.puuid === "DIA");
  assert.equal(apexCalls.length, 3);
  assert.deepEqual(
    apexCalls.map((c) => c.opts.start),
    [0, 100, 200],
  );
  assert.equal(diaCalls.length, 1);
});

test("paging stops early on a short page", async () => {
  await seedSummoner(db, "na1", "APEX", "GRANDMASTER");
  const fullPage = Array.from({ length: 100 }, (_, i) => `NA1_F${i}`);
  const client = mockClient({ APEX: [fullPage, ["NA1_LAST"]] });
  const result = await runMatchIdCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.equal(client.calls.length, 2);
  assert.equal(result.discovered, 101);
});

test("a Riot 400 marks the summoner fetch_errored without stamping or throwing", async () => {
  await seedSummoner(db, "na1", "GONE", "MASTER");
  const client = mockClient({ GONE: "400" });
  const result = await runMatchIdCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.equal(result.summonersProcessed, 1);
  const [s] = (await db.query("SELECT * FROM summoners")).rows;
  assert.equal(s.fetch_errored, true);
  assert.equal(s.matches_fetched_at, null);
});

test("a non-400 error leaves the summoner retryable and continues the batch", async () => {
  await seedSummoner(db, "na1", "FLAKY", "CHALLENGER");
  await seedSummoner(db, "na1", "OK", "DIAMOND");
  const client = mockClient({ FLAKY: "boom", OK: [["NA1_1"]] });
  const result = await runMatchIdCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.equal(result.discovered, 1);
  const { rows } = await db.query("SELECT puuid, fetch_errored, matches_fetched_at FROM summoners ORDER BY puuid");
  assert.deepEqual(
    rows.map((r) => [r.puuid, r.fetch_errored, r.matches_fetched_at === null]),
    [
      ["FLAKY", false, true], // untouched → retried next cycle
      ["OK", false, false],
    ],
  );
});

test("pauses without client calls when the pending backlog exceeds the threshold", async () => {
  await seedSummoner(db, "na1", "P1", "MASTER");
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2", "NA1_3"],
  });
  const client = mockClient({ P1: [["NA1_9"]] });
  const config = loadConfig({ COLLECTOR_BACKLOG_PAUSE: "2" });
  const result = await runMatchIdCycle({ client, db, config, region: "na1", logger: silentLogger });
  assert.deepEqual(result, { paused: true, summonersProcessed: 0, discovered: 0 });
  assert.equal(client.calls.length, 0);
});

test("backlog pause is per-region", async () => {
  await seedSummoner(db, "na1", "P1", "MASTER");
  await insertPendingMatches(db, {
    region: "kr",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["KR_1", "KR_2", "KR_3"],
  });
  const config = loadConfig({ COLLECTOR_BACKLOG_PAUSE: "2" });
  const client = mockClient({ P1: [["NA1_9"]] });
  const result = await runMatchIdCycle({ client, db, config, region: "na1", logger: silentLogger });
  assert.equal(result.paused, false);
  assert.equal(result.discovered, 1);
});

test("shouldStop ends the cycle between summoners; the rest stay unstamped", async () => {
  await seedSummoner(db, "na1", "P1", "DIAMOND");
  await seedSummoner(db, "na1", "P2", "DIAMOND");
  await seedSummoner(db, "na1", "P3", "DIAMOND");
  let stop = false;
  const inner = mockClient({ P1: [["NA1_1"]], P2: [["NA1_2"]], P3: [["NA1_3"]] });
  const client = {
    async getMatchIdsByPuuid(...args) {
      stop = true;
      return inner.getMatchIdsByPuuid(...args);
    },
  };
  const result = await runMatchIdCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
    shouldStop: () => stop,
  });
  assert.equal(result.summonersProcessed, 1);
  assert.equal(result.discovered, 1);
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM summoners WHERE matches_fetched_at IS NULL",
  );
  assert.equal(rows[0].n, 2);
});
