// scripts/ugg-scraper/playerSchema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { canonicalizeRole, extractRolePerformances, canonicalizeEntries } from "./playerSchema.mjs";
import { loadIdToAlias } from "./championIds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(__dirname, "fixtures", "player", name), "utf-8"));

test("canonicalizeRole maps u.gg role ids to engine roles (3->adc, 5->mid)", () => {
  assert.equal(canonicalizeRole(1), "jungle");
  assert.equal(canonicalizeRole(2), "support");
  assert.equal(canonicalizeRole(3), "adc");
  assert.equal(canonicalizeRole(4), "top");
  assert.equal(canonicalizeRole(5), "mid");
  assert.equal(canonicalizeRole(7), null);
});

test("loadIdToAlias resolves a known champion (Annie=1)", () => {
  assert.equal(loadIdToAlias()[1], "Annie");
});

test("extractRolePerformances picks the ranked-solo (420) block + its role", () => {
  const out = extractRolePerformances(fx("na-jungle.json"));
  assert.equal(out.roleId, 1);
  assert.equal(out.records.length, 4);
  assert.deepEqual(out.records[0], { numericChampionId: 64, games: 133, wins: 69 });
});

test("canonicalizeEntries produces the recorded jungle entries", () => {
  const expected = fx("na-jungle.expected.json");
  const entries = canonicalizeEntries(fx("na-jungle.json"), { idToAlias: loadIdToAlias() });
  assert.deepEqual(entries, expected.entries);
});

test("empty/private profile canonicalizes to no entries", () => {
  const entries = canonicalizeEntries(fx("empty-private.json"), { idToAlias: loadIdToAlias() });
  assert.deepEqual(entries, []);
});

test("unknown numeric championId is dropped, not crashed", () => {
  const raw = { data: { fetchPlayerStatistics: [
    { queueType: 420, role: 1, basicChampionPerformances: [{ championId: 999999, totalMatches: 5, wins: 3 }] },
  ] } };
  assert.deepEqual(canonicalizeEntries(raw, { idToAlias: {} }), []);
});

test("non-positive games rows are dropped", () => {
  const raw = { data: { fetchPlayerStatistics: [
    { queueType: 420, role: 1, basicChampionPerformances: [{ championId: 1, totalMatches: 0, wins: 0 }] },
  ] } };
  assert.deepEqual(canonicalizeEntries(raw, { idToAlias: { 1: "Annie" } }), []);
});

test("a response with no ranked-solo (420) block yields no entries", () => {
  const raw = { data: { fetchPlayerStatistics: [
    { queueType: 440, role: 1, basicChampionPerformances: [{ championId: 1, totalMatches: 5, wins: 3 }] },
  ] } };
  assert.deepEqual(canonicalizeEntries(raw, { idToAlias: { 1: "Annie" } }), []);
});
