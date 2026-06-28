// scripts/ugg-scraper/uggPlayerClient.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { scoutPlayer } from "./uggPlayerClient.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(__dirname, "fixtures", "player", name), "utf-8"));
const NOW = new Date("2026-06-28T12:00:00.000Z");

test("scoutPlayer unions per-role responses into one envelope", async () => {
  const calls = [];
  const fetcher = {
    postJson: async (_url, body) => {
      calls.push(body.variables.role);
      // role 1 returns the jungle fixture; roles 2-5 return empty.
      return body.variables.role === 1 ? fx("na-jungle.json") : fx("empty-private.json");
    },
  };
  const env = await scoutPlayer({ region: "na1", gameName: "Aeon", tagLine: "NA3", fetcher, now: NOW });
  assert.equal(env.provider, "ugg");
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.fetchedAt, NOW.toISOString());
  assert.equal(env.season, "26");
  assert.equal(env.queue, "ranked_solo_5x5");
  assert.deepEqual(env.entries, fx("na-jungle.expected.json").entries);
  // one request per role (5), each carrying its scalar role id.
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
});

test("scoutPlayer lowercases the riot id + region in the query body", async () => {
  let captured;
  const fetcher = { postJson: async (_u, body) => { captured = body; return fx("empty-private.json"); } };
  await scoutPlayer({ region: "NA1", gameName: "Aeon", tagLine: "NA3", fetcher, now: NOW });
  assert.equal(captured.variables.riotUserName, "aeon");
  assert.equal(captured.variables.riotTagLine, "na3");
  assert.equal(captured.variables.regionId, "na1");
});

test("scoutPlayer on an all-empty/private profile returns empty entries", async () => {
  const fetcher = { postJson: async () => fx("empty-private.json") };
  const env = await scoutPlayer({ region: "na1", gameName: "Ghost", tagLine: "NA1", fetcher, now: NOW });
  assert.deepEqual(env.entries, []);
});

test("scoutPlayer tolerates a null (404/403) role response", async () => {
  const fetcher = { postJson: async (_u, body) => (body.variables.role === 1 ? fx("na-jungle.json") : null) };
  const env = await scoutPlayer({ region: "na1", gameName: "Aeon", tagLine: "NA3", fetcher, now: NOW });
  assert.deepEqual(env.entries, fx("na-jungle.expected.json").entries);
});
