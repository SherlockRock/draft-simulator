import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  createDb,
  migrate,
  withTransaction,
  upsertSummoners,
  selectSummonersToFetch,
  markSummonerMatchesFetched,
  markSummonerFetchErrored,
  insertPendingMatches,
  claimPendingMatches,
  markMatchFetched,
  markMatchSkipped,
  markMatchFailed,
  countMatchesByStatus,
} from "./db.mjs";

// Throwaway DB on the dev machine's local Postgres, peer-auth over the unix
// socket (no password). Never point this at forge.
const SOCKET = "/var/run/postgresql";
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? `postgresql://rsmith@/postgres?host=${SOCKET}`;
const TEST_DB = "fp_collector_test";
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgresql://rsmith@/${TEST_DB}?host=${SOCKET}`;

let db;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  db = createDb(TEST_URL);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  // First beforeEach runs before migrate() has been called by the first test;
  // tolerate missing tables.
  await db.query("DROP TABLE IF EXISTS summoners, matches");
  await migrate(db);
});

const SUMMONER = (over = {}) => ({
  puuid: "P1",
  tier: "CHALLENGER",
  division: "I",
  leaguePoints: 800,
  ...over,
});

test("migrate() is idempotent and creates both tables", async () => {
  await migrate(db);
  await migrate(db);
  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('summoners','matches') ORDER BY table_name",
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ["matches", "summoners"],
  );
});

test("upsertSummoners inserts new rows with rank_updated_at stamped", async () => {
  await upsertSummoners(db, "na1", [SUMMONER(), SUMMONER({ puuid: "P2", tier: "DIAMOND" })]);
  const { rows } = await db.query("SELECT * FROM summoners ORDER BY puuid");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].puuid, "P1");
  assert.equal(rows[0].region, "na1");
  assert.equal(rows[0].tier, "CHALLENGER");
  assert.equal(rows[0].league_points, 800);
  assert.ok(rows[0].rank_updated_at instanceof Date);
  assert.equal(rows[0].matches_fetched_at, null);
  assert.equal(rows[0].fetch_errored, false);
});

test("upsertSummoners updates rank fields on conflict but preserves fetch state", async () => {
  await upsertSummoners(db, "na1", [SUMMONER()]);
  await markSummonerMatchesFetched(db, "P1");
  await markSummonerFetchErrored(db, "P1");
  const before = (await db.query("SELECT * FROM summoners")).rows[0];

  await upsertSummoners(db, "na1", [SUMMONER({ tier: "GRANDMASTER", leaguePoints: 950 })]);
  const after = (await db.query("SELECT * FROM summoners")).rows[0];
  assert.equal(after.tier, "GRANDMASTER");
  assert.equal(after.league_points, 950);
  assert.ok(after.rank_updated_at > before.rank_updated_at);
  assert.deepEqual(after.matches_fetched_at, before.matches_fetched_at);
  assert.equal(after.fetch_errored, true);
});

test("upsertSummoners chunks large batches", async () => {
  const many = Array.from({ length: 5 }, (_, i) => SUMMONER({ puuid: `P${i}` }));
  await upsertSummoners(db, "na1", many, { chunkSize: 2 });
  const { rows } = await db.query("SELECT count(*)::int AS n FROM summoners");
  assert.equal(rows[0].n, 5);
});

test("selectSummonersToFetch returns never-fetched summoners in the region", async () => {
  await upsertSummoners(db, "na1", [SUMMONER()]);
  await upsertSummoners(db, "euw1", [SUMMONER({ puuid: "P2" })]);
  const rows = await selectSummonersToFetch(db, { region: "na1", limit: 10 });
  assert.deepEqual(
    rows.map((r) => r.puuid),
    ["P1"],
  );
});

test("selectSummonersToFetch excludes recently-fetched, stale-rank, and errored summoners", async () => {
  await upsertSummoners(db, "na1", [
    SUMMONER({ puuid: "FRESH" }),
    SUMMONER({ puuid: "JUSTFETCHED" }),
    SUMMONER({ puuid: "STALEFETCH" }),
    SUMMONER({ puuid: "STALERANK" }),
    SUMMONER({ puuid: "ERRORED" }),
  ]);
  await markSummonerMatchesFetched(db, "JUSTFETCHED");
  await db.query(
    "UPDATE summoners SET matches_fetched_at = now() - interval '3 days' WHERE puuid = 'STALEFETCH'",
  );
  await db.query(
    "UPDATE summoners SET rank_updated_at = now() - interval '8 days' WHERE puuid = 'STALERANK'",
  );
  await markSummonerFetchErrored(db, "ERRORED");

  const rows = await selectSummonersToFetch(db, { region: "na1", limit: 10 });
  assert.deepEqual(rows.map((r) => r.puuid).sort(), ["FRESH", "STALEFETCH"]);
});

test("selectSummonersToFetch orders apex tiers before Diamond", async () => {
  await upsertSummoners(db, "na1", [
    SUMMONER({ puuid: "DIA", tier: "DIAMOND" }),
    SUMMONER({ puuid: "MAS", tier: "MASTER" }),
    SUMMONER({ puuid: "CHA", tier: "CHALLENGER" }),
    SUMMONER({ puuid: "GM", tier: "GRANDMASTER" }),
  ]);
  const rows = await selectSummonersToFetch(db, { region: "na1", limit: 10 });
  assert.deepEqual(
    rows.map((r) => r.puuid),
    ["CHA", "GM", "MAS", "DIA"],
  );
});

test("selectSummonersToFetch returns tier and division for seed stamping", async () => {
  await upsertSummoners(db, "na1", [SUMMONER({ tier: "DIAMOND", division: "II" })]);
  const [row] = await selectSummonersToFetch(db, { region: "na1", limit: 1 });
  assert.equal(row.tier, "DIAMOND");
  assert.equal(row.division, "II");
});

test("insertPendingMatches inserts with seed rank and dedupes on match_id", async () => {
  const first = await insertPendingMatches(db, {
    region: "na1",
    seedTier: "CHALLENGER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2"],
  });
  assert.equal(first, 2);
  // Second summoner shares NA1_2 — only NA1_3 is new.
  const second = await insertPendingMatches(db, {
    region: "na1",
    seedTier: "DIAMOND",
    seedDivision: "II",
    matchIds: ["NA1_2", "NA1_3"],
  });
  assert.equal(second, 1);

  const { rows } = await db.query("SELECT * FROM matches ORDER BY match_id");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "pending");
  // Original seed rank preserved on the deduped row.
  assert.equal(rows[1].seed_tier, "CHALLENGER");
  assert.equal(rows[2].seed_tier, "DIAMOND");
});

test("claimPendingMatches returns up to limit pending match ids for the region", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2", "NA1_3"],
  });
  await insertPendingMatches(db, {
    region: "kr",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["KR_1"],
  });
  const claimed = await claimPendingMatches(db, { region: "na1", limit: 2 });
  assert.equal(claimed.length, 2);
  assert.ok(claimed.every((r) => r.match_id.startsWith("NA1_")));
});

test("claimPendingMatches skips rows locked by a concurrent claimer", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "MASTER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2", "NA1_3", "NA1_4"],
  });
  await withTransaction(db, async (client) => {
    const mine = await claimPendingMatches(db, { region: "na1", limit: 2, client });
    assert.equal(mine.length, 2);
    const theirs = await claimPendingMatches(db, { region: "na1", limit: 10 });
    const overlap = theirs.filter((t) => mine.some((m) => m.match_id === t.match_id));
    assert.equal(overlap.length, 0, "locked rows must be skipped");
    assert.equal(theirs.length, 2);
  });
});

test("markMatchFetched writes extracted columns, teams JSONB, and status", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "CHALLENGER",
    seedDivision: "I",
    matchIds: ["NA1_1"],
  });
  const teams = { 100: { TOP: { championId: 266 } }, 200: { TOP: { championId: 17 } } };
  await markMatchFetched(db, "NA1_1", {
    queueId: 420,
    gameVersion: "16.16.703.1234",
    patchMajor: 16,
    patchMinor: 16,
    gameDuration: 1875,
    gameStart: new Date("2026-08-20T18:00:00Z"),
    teams,
    extractorVersion: 1,
  });
  const { rows } = await db.query("SELECT * FROM matches");
  const row = rows[0];
  assert.equal(row.status, "fetched");
  assert.equal(row.queue_id, 420);
  assert.equal(row.game_version, "16.16.703.1234");
  assert.equal(row.patch_major, 16);
  assert.equal(row.patch_minor, 16);
  assert.equal(row.game_duration, 1875);
  assert.deepEqual(row.game_start, new Date("2026-08-20T18:00:00Z"));
  assert.deepEqual(row.teams, teams);
  assert.equal(row.extractor_version, 1);
  assert.ok(row.updated_at >= row.created_at);
});

test("markMatchSkipped and markMatchFailed record status and error_detail", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "CHALLENGER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2"],
  });
  await markMatchSkipped(db, "NA1_1", "non-420 queue (700)");
  await markMatchFailed(db, "NA1_2", "404 after retries");
  const { rows } = await db.query("SELECT * FROM matches ORDER BY match_id");
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].error_detail, "non-420 queue (700)");
  assert.equal(rows[1].status, "failed");
  assert.equal(rows[1].error_detail, "404 after retries");
});

test("countMatchesByStatus returns per-status counts for the region", async () => {
  await insertPendingMatches(db, {
    region: "na1",
    seedTier: "CHALLENGER",
    seedDivision: "I",
    matchIds: ["NA1_1", "NA1_2", "NA1_3"],
  });
  await markMatchSkipped(db, "NA1_3", "remake");
  const counts = await countMatchesByStatus(db, "na1");
  assert.deepEqual(counts, { pending: 2, fetched: 0, skipped: 1, failed: 0 });
});
