import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { insertPendingMatches } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { makeTestDb, silentLogger } from "./test-support.mjs";
import { buildMatchDto, buildTimelineDto } from "./test-fixtures.mjs";
import { EXTRACTOR_VERSION } from "./extractor.mjs";
import { runProcessorCycle } from "./processor.mjs";

let db;

before(async () => {
  db = await makeTestDb("fp_collector_processor_test");
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE summoners, matches");
});

/**
 * Mock client keyed by matchId → { match, timeline } or "404"/"boom" to throw.
 */
function mockClient(fixtures) {
  const calls = [];
  const lookup = (matchId, kind) => {
    const fx = fixtures[matchId];
    if (fx === "404") throw new Error(`Riot API 404 from https://x/${matchId}`);
    if (fx === "boom") throw new Error("socket hang up");
    return fx[kind];
  };
  return {
    calls,
    async getMatch(matchId, continent) {
      calls.push({ kind: "match", matchId, continent });
      return lookup(matchId, "match");
    },
    async getMatchTimeline(matchId, continent) {
      calls.push({ kind: "timeline", matchId, continent });
      return lookup(matchId, "timeline");
    },
  };
}

const seedPending = (ids, region = "na1") =>
  insertPendingMatches(db, { region, seedTier: "MASTER", seedDivision: "I", matchIds: ids });

test("drains a batch: fetches match+timeline, writes columns and teams JSONB", async () => {
  await seedPending(["NA1_1"]);
  const client = mockClient({
    NA1_1: { match: buildMatchDto({ matchId: "NA1_1" }), timeline: buildTimelineDto() },
  });
  const result = await runProcessorCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.deepEqual(result, { claimed: 1, fetched: 1, skipped: 0, failed: 0 });

  const [row] = (await db.query("SELECT * FROM matches")).rows;
  assert.equal(row.status, "fetched");
  assert.equal(row.queue_id, 420);
  assert.equal(row.game_version, "15.16.703.1234");
  assert.equal(row.patch_major, 15);
  assert.equal(row.patch_minor, 16);
  assert.equal(row.game_duration, 1900);
  assert.deepEqual(row.game_start, new Date(1_755_700_000_000));
  assert.equal(row.extractor_version, EXTRACTOR_VERSION);
  assert.equal(row.teams["100"].win, true);
  assert.equal(row.teams["100"].participants.TOP.championId, 1);
  assert.equal(row.teams["200"].participants.UTILITY.timeline["900000"].level, 8);
  // Both requests continent-routed
  assert.ok(client.calls.every((c) => c.continent === "americas"));
});

test("extraction rejection marks skipped with the reason", async () => {
  await seedPending(["NA1_REMAKE"]);
  const client = mockClient({
    NA1_REMAKE: {
      match: buildMatchDto({ matchId: "NA1_REMAKE", gameDuration: 200 }),
      timeline: buildTimelineDto({ minutes: 3 }),
    },
  });
  const result = await runProcessorCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.deepEqual(result, { claimed: 1, fetched: 0, skipped: 1, failed: 0 });
  const [row] = (await db.query("SELECT status, error_detail FROM matches")).rows;
  assert.equal(row.status, "skipped");
  assert.match(row.error_detail, /duration 200/);
});

test("a fetch error marks failed with error_detail and does not sink the batch", async () => {
  await seedPending(["NA1_GONE", "NA1_OK"]);
  const client = mockClient({
    NA1_GONE: "404",
    NA1_OK: { match: buildMatchDto({ matchId: "NA1_OK" }), timeline: buildTimelineDto() },
  });
  const result = await runProcessorCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.deepEqual(result, { claimed: 2, fetched: 1, skipped: 0, failed: 1 });
  const { rows } = await db.query("SELECT match_id, status, error_detail FROM matches ORDER BY match_id");
  assert.equal(rows[0].match_id, "NA1_GONE");
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error_detail, /404/);
  assert.equal(rows[1].status, "fetched");
});

test("claims at most processorBatchSize and only from its region", async () => {
  await seedPending(["NA1_1", "NA1_2", "NA1_3"]);
  await seedPending(["KR_1"], "kr");
  const fx = {};
  for (const id of ["NA1_1", "NA1_2", "NA1_3"]) {
    fx[id] = { match: buildMatchDto({ matchId: id }), timeline: buildTimelineDto() };
  }
  const client = mockClient(fx);
  const config = loadConfig({ COLLECTOR_PROCESSOR_BATCH: "2" });
  const result = await runProcessorCycle({ client, db, config, region: "na1", logger: silentLogger });
  assert.equal(result.claimed, 2);
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM matches WHERE status = 'pending'",
  );
  assert.equal(rows[0].n, 2); // NA1_3 + KR_1 untouched
});

test("an empty queue makes no client calls", async () => {
  const client = mockClient({});
  const result = await runProcessorCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.deepEqual(result, { claimed: 0, fetched: 0, skipped: 0, failed: 0 });
  assert.equal(client.calls.length, 0);
});

test("a key-manager abort leaves claimed rows pending for the next run", async () => {
  await seedPending(["NA1_1", "NA1_2"]);
  const client = {
    async getMatch() {
      throw new Error("key-manager aborted");
    },
    async getMatchTimeline() {
      throw new Error("key-manager aborted");
    },
  };
  const result = await runProcessorCycle({
    client,
    db,
    config: loadConfig({}),
    region: "na1",
    logger: silentLogger,
  });
  assert.equal(result.failed, 0);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM matches WHERE status = 'pending'");
  assert.equal(rows[0].n, 2);
});

test("bounded concurrency: in-flight matches never exceed processorConcurrency", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `NA1_${i}`);
  await seedPending(ids);
  let inFlight = 0;
  let peak = 0;
  const fx = {};
  for (const id of ids) fx[id] = { match: buildMatchDto({ matchId: id }), timeline: buildTimelineDto() };
  const client = {
    async getMatch(matchId) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fx[matchId].match;
    },
    async getMatchTimeline(matchId) {
      return fx[matchId].timeline;
    },
  };
  const config = loadConfig({ COLLECTOR_PROCESSOR_CONCURRENCY: "2" });
  const result = await runProcessorCycle({ client, db, config, region: "na1", logger: silentLogger });
  assert.equal(result.fetched, 6);
  assert.ok(peak <= 2, `peak in-flight ${peak} > 2`);
});
