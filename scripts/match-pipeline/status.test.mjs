import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { upsertSummoners, insertPendingMatches, markMatchFetched, markMatchSkipped } from "./db.mjs";
import { makeTestDb } from "./test-support.mjs";
import { collectStatus } from "./status.mjs";

let db;

before(async () => {
  db = await makeTestDb("fp_collector_status_test");
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE summoners, matches");
});

const fetchedFields = (patchMinor = 16) => ({
  queueId: 420,
  gameVersion: `15.${patchMinor}.703.1234`,
  patchMajor: 15,
  patchMinor,
  gameDuration: 1900,
  gameStart: new Date(),
  teams: {},
  extractorVersion: 1,
});

test("collectStatus aggregates summoners, statuses, last-24h, and patch mix per region", async () => {
  await upsertSummoners(db, "na1", [
    { puuid: "P1", tier: "CHALLENGER", division: "I", leaguePoints: 1 },
    { puuid: "P2", tier: "DIAMOND", division: "II", leaguePoints: 2 },
  ]);
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "CHALLENGER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2", "NA1_3", "NA1_4"],
  });
  await markMatchFetched(db, "NA1_1", fetchedFields(16));
  await markMatchFetched(db, "NA1_2", fetchedFields(15));
  await markMatchSkipped(db, "NA1_3", "remake");
  // An old fetch that must not count toward the last-24h number.
  await db.query("UPDATE matches SET updated_at = now() - interval '2 days' WHERE match_id = 'NA1_2'");

  const status = await collectStatus(db, { regions: ["na1", "kr"] });
  const na1 = status.regions.na1;
  assert.equal(na1.summoners, 2);
  assert.equal(na1.summonersErrored, 0);
  assert.deepEqual(na1.matches, { pending: 1, fetched: 2, skipped: 1, failed: 0 });
  assert.equal(na1.fetchedLast24h, 1);
  assert.deepEqual(na1.patchMix, [
    { patch: "15.15", count: 1 },
    { patch: "15.16", count: 1 },
  ]);
  assert.deepEqual(status.regions.kr.matches, { pending: 0, fetched: 0, skipped: 0, failed: 0 });
});

test("likelyKeyExpired: pending backlog with no recent fetches", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2"],
  });
  const stale = await collectStatus(db, { regions: ["na1"] });
  assert.equal(stale.regions.na1.likelyKeyExpired, true);

  await markMatchFetched(db, "NA1_1", fetchedFields());
  const active = await collectStatus(db, { regions: ["na1"] });
  assert.equal(active.regions.na1.likelyKeyExpired, false);

  // No backlog at all → not a key problem, just idle.
  await markMatchSkipped(db, "NA1_2", "x");
  await db.query("UPDATE matches SET updated_at = now() - interval '2 hours'");
  const idle = await collectStatus(db, { regions: ["na1"] });
  assert.equal(idle.regions.na1.likelyKeyExpired, false);
});
