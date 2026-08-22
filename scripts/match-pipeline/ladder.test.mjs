import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createDb, migrate } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { runLadderOnce } from "./ladder.mjs";

const SOCKET = "/var/run/postgresql";
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? `postgresql://rsmith@/postgres?host=${SOCKET}`;
const TEST_DB = "fp_collector_ladder_test";
const TEST_URL =
  process.env.TEST_DATABASE_URL_LADDER ?? `postgresql://rsmith@/${TEST_DB}?host=${SOCKET}`;

let db;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  db = createDb(TEST_URL);
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE summoners, matches");
});

const apexEntry = (puuid, leaguePoints = 500) => ({ puuid, rank: "I", leaguePoints });
const diamondEntry = (puuid, division) => ({
  puuid,
  tier: "DIAMOND",
  rank: division,
  leaguePoints: 40,
});

/**
 * Mock client: apex tiers keyed by tier name; diamond pages keyed by
 * "DIVISION/page". Records calls for assertion.
 */
function mockClient({ apex = {}, diamondPages = {} } = {}) {
  const calls = { apex: [], entries: [] };
  return {
    calls,
    async getApexEntries({ tier, queue, platform }) {
      calls.apex.push({ tier, queue, platform });
      return { tier, entries: apex[tier] ?? [] };
    },
    async getLeagueEntries({ queue, tier, division, page, platform }) {
      calls.entries.push({ queue, tier, division, page, platform });
      return diamondPages[`${division}/${page}`] ?? [];
    },
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

test("runLadderOnce upserts all three apex tiers with division I", async () => {
  const client = mockClient({
    apex: {
      CHALLENGER: [apexEntry("C1", 900)],
      GRANDMASTER: [apexEntry("G1")],
      MASTER: [apexEntry("M1"), apexEntry("M2")],
    },
  });
  const config = loadConfig({ COLLECTOR_DIAMOND_PAGE_CAP: "0" });
  const count = await runLadderOnce({ client, db, config, region: "na1", logger: silentLogger });
  assert.equal(count, 4);

  const { rows } = await db.query("SELECT * FROM summoners ORDER BY puuid");
  assert.deepEqual(
    rows.map((r) => [r.puuid, r.tier, r.division]),
    [
      ["C1", "CHALLENGER", "I"],
      ["G1", "GRANDMASTER", "I"],
      ["M1", "MASTER", "I"],
      ["M2", "MASTER", "I"],
    ],
  );
  assert.equal(rows[0].league_points, 900);
  assert.equal(rows[0].region, "na1");
  assert.deepEqual(
    client.calls.apex.map((c) => c.tier),
    ["CHALLENGER", "GRANDMASTER", "MASTER"],
  );
  assert.ok(client.calls.apex.every((c) => c.queue === "RANKED_SOLO_5x5" && c.platform === "na1"));
});

test("runLadderOnce pages each Diamond division until an empty page", async () => {
  const client = mockClient({
    diamondPages: {
      "I/1": [diamondEntry("D1", "I"), diamondEntry("D2", "I")],
      "I/2": [diamondEntry("D3", "I")],
      // I/3 empty → stop
      "II/1": [diamondEntry("D4", "II")],
      // II/2 empty → stop
    },
  });
  const config = loadConfig({});
  const count = await runLadderOnce({ client, db, config, region: "euw1", logger: silentLogger });
  assert.equal(count, 4);

  const { rows } = await db.query("SELECT puuid, tier, division FROM summoners ORDER BY puuid");
  assert.deepEqual(
    rows.map((r) => [r.puuid, r.tier, r.division]),
    [
      ["D1", "DIAMOND", "I"],
      ["D2", "DIAMOND", "I"],
      ["D3", "DIAMOND", "I"],
      ["D4", "DIAMOND", "II"],
    ],
  );
  const pagesAsked = client.calls.entries.map((c) => `${c.division}/${c.page}`);
  assert.deepEqual(pagesAsked, ["I/1", "I/2", "I/3", "II/1", "II/2"]);
  assert.ok(client.calls.entries.every((c) => c.tier === "DIAMOND" && c.platform === "euw1"));
});

test("runLadderOnce respects the Diamond page cap", async () => {
  const pages = {};
  for (let p = 1; p <= 10; p++) {
    pages[`I/${p}`] = [diamondEntry(`D${p}`, "I")];
    pages[`II/${p}`] = [];
  }
  const client = mockClient({ diamondPages: pages });
  const config = loadConfig({ COLLECTOR_DIAMOND_PAGE_CAP: "3" });
  await runLadderOnce({ client, db, config, region: "na1", logger: silentLogger });
  const iPages = client.calls.entries.filter((c) => c.division === "I").length;
  assert.equal(iPages, 3);
});

test("runLadderOnce skips entries without a puuid", async () => {
  const client = mockClient({
    apex: { CHALLENGER: [apexEntry("C1"), { rank: "I", leaguePoints: 1 }] },
  });
  const config = loadConfig({ COLLECTOR_DIAMOND_PAGE_CAP: "0" });
  const count = await runLadderOnce({ client, db, config, region: "na1", logger: silentLogger });
  assert.equal(count, 1);
});
