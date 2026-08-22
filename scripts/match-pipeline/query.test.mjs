import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { insertPendingMatches, markMatchFetched } from "./db.mjs";
import { makeTestDb } from "./test-support.mjs";
import { computeStats, computeWinrate, computeMatchup } from "./query.mjs";

let db;

before(async () => {
  db = await makeTestDb("fp_collector_query_test");
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE summoners, matches");
});

const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

/** Minimal teams JSONB: filler champs 900+ everywhere except overrides. */
function teamsJson({ winner = 100, roles100 = {}, roles200 = {} }) {
  const side = (base, overrides, win) => ({
    win,
    bans: [],
    participants: Object.fromEntries(
      POSITIONS.map((p, i) => [p, { championId: overrides[p] ?? base + i }]),
    ),
  });
  return {
    100: side(900, roles100, winner === 100),
    200: side(950, roles200, winner === 200),
  };
}

let nextId = 0;
async function seedFetched({ winner, roles100, roles200, patchMinor = 16, seedTier = "MASTER", region = "na1" }) {
  const matchId = `NA1_${++nextId}`;
  await insertPendingMatches(db, { region, seedTier, seedDivision: "I", matchIds: [matchId] });
  await markMatchFetched(db, matchId, {
    queueId: 420,
    gameVersion: `15.${patchMinor}.1.1`,
    patchMajor: 15,
    patchMinor,
    gameDuration: 1900,
    gameStart: new Date(),
    teams: teamsJson({ winner, roles100, roles200 }),
    extractorVersion: 1,
  });
}

test("computeWinrate counts games and wins for a champion in a role on either side", async () => {
  await seedFetched({ winner: 100, roles100: { TOP: 266 } }); // win
  await seedFetched({ winner: 100, roles200: { TOP: 266 } }); // loss
  await seedFetched({ winner: 200, roles200: { TOP: 266 } }); // win
  await seedFetched({ winner: 100, roles100: { MIDDLE: 266 } }); // other role — excluded

  const result = await computeWinrate(db, { championId: 266, role: "TOP" });
  assert.equal(result.games, 3);
  assert.equal(result.wins, 2);
});

test("computeMatchup is direction-aware for two champions in the same role", async () => {
  await seedFetched({ winner: 100, roles100: { TOP: 266 }, roles200: { TOP: 17 } }); // 266 beats 17
  await seedFetched({ winner: 100, roles100: { TOP: 17 }, roles200: { TOP: 266 } }); // 17 beats 266
  await seedFetched({ winner: 200, roles100: { TOP: 266 }, roles200: { TOP: 17 } }); // 17 beats 266
  await seedFetched({ winner: 100, roles100: { JUNGLE: 266 }, roles200: { JUNGLE: 17 } }); // other role

  const result = await computeMatchup(db, { championId: 266, opponentId: 17, role: "TOP" });
  assert.equal(result.games, 3);
  assert.equal(result.wins, 1);
});

test("computeStats aggregates fetched totals by patch and seed tier", async () => {
  await seedFetched({ winner: 100, patchMinor: 15, seedTier: "CHALLENGER" });
  await seedFetched({ winner: 100, patchMinor: 16, seedTier: "CHALLENGER" });
  await seedFetched({ winner: 200, patchMinor: 16, seedTier: "DIAMOND" });

  const stats = await computeStats(db);
  assert.equal(stats.fetched, 3);
  assert.deepEqual(stats.byPatch, [
    { patch: "15.15", count: 1 },
    { patch: "15.16", count: 2 },
  ]);
  assert.deepEqual(stats.bySeedTier, [
    { seedTier: "CHALLENGER", count: 2 },
    { seedTier: "DIAMOND", count: 1 },
  ]);
});
