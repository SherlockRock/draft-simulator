// scripts/champion-positions/merge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeChampionRows, DISPLAY_NAME_OVERRIDES } from "./merge.mjs";
import { normalize } from "../lib/fetch-utils.mjs";

const meraki = (entries) => new Map(entries.map(([name, positions]) => [normalize(name), { positions }]));

test("an existing id keeps its positions and extra fields; DDragon owns the display name", () => {
  const existing = [{ name: "Vayne", id: "Vayne", positions: ["TOP", "BOTTOM"], playable: ["TOP", "BOTTOM", "MIDDLE"] }];
  const ddragon = [{ id: "Vayne", name: "Vayne" }];
  const { champions, added, vanished } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([["Vayne", ["BOTTOM", "TOP"]]]) });
  assert.deepEqual(champions, [{ name: "Vayne", id: "Vayne", positions: ["TOP", "BOTTOM"], playable: ["TOP", "BOTTOM", "MIDDLE"] }]);
  assert.deepEqual(added, []);
  assert.deepEqual(vanished, []);
});

test("a DDragon rename reaches the row, with the display override applied", () => {
  const existing = [{ name: "Nunu", id: "Nunu", positions: ["JUNGLE"] }, { name: "Wukong", id: "MonkeyKing", positions: ["JUNGLE"] }];
  const ddragon = [{ id: "Nunu", name: "Nunu & Willump" }, { id: "MonkeyKing", name: "Wukong (renamed)" }];
  const { champions } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([]) });
  assert.equal(champions.find((c) => c.id === "Nunu").name, DISPLAY_NAME_OVERRIDES["Nunu & Willump"]);
  assert.equal(champions.find((c) => c.id === "MonkeyKing").name, "Wukong (renamed)");
});

test("a new DDragon id is added with Meraki positions, or [] and a report when Meraki lacks it", () => {
  const existing = [{ name: "Ahri", id: "Ahri", positions: ["MIDDLE"] }];
  const ddragon = [{ id: "Ahri", name: "Ahri" }, { id: "Locke", name: "Locke" }, { id: "Newbie", name: "Newbie" }];
  const { champions, added, missingFromMeraki } = mergeChampionRows({
    existing, ddragon, merakiByName: meraki([["Locke", ["MIDDLE"]]]),
  });
  assert.deepEqual(added, ["Locke", "Newbie"]);
  assert.deepEqual(champions.find((c) => c.id === "Locke"), { name: "Locke", id: "Locke", positions: ["MIDDLE"] });
  assert.deepEqual(champions.find((c) => c.id === "Newbie"), { name: "Newbie", id: "Newbie", positions: [] });
  assert.deepEqual(missingFromMeraki, ["Newbie"]);
});

test("Meraki is never consulted for an existing id, even when it disagrees", () => {
  const existing = [{ name: "Sylas", id: "Sylas", positions: ["MIDDLE", "JUNGLE", "SUPPORT"] }];
  const ddragon = [{ id: "Sylas", name: "Sylas" }];
  const { champions } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([["Sylas", ["MIDDLE", "TOP"]]]) });
  assert.deepEqual(champions[0].positions, ["MIDDLE", "JUNGLE", "SUPPORT"]);
});

test("an id DDragon no longer returns is kept and reported, never dropped", () => {
  const existing = [{ name: "Ahri", id: "Ahri", positions: ["MIDDLE"] }, { name: "Gone", id: "Gone", positions: ["TOP"] }];
  const ddragon = [{ id: "Ahri", name: "Ahri" }];
  const { champions, vanished } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([]) });
  assert.deepEqual(vanished, ["Gone"]);
  assert.deepEqual(champions.map((c) => c.id), ["Ahri", "Gone"]);
});

test("output is sorted by display name like the file has always been", () => {
  const existing = [{ name: "Zed", id: "Zed", positions: ["MIDDLE"] }, { name: "Ahri", id: "Ahri", positions: ["MIDDLE"] }];
  const ddragon = [{ id: "Zed", name: "Zed" }, { id: "Ahri", name: "Ahri" }, { id: "Bard", name: "Bard" }];
  const { champions } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([["Bard", ["SUPPORT"]]]) });
  assert.deepEqual(champions.map((c) => c.name), ["Ahri", "Bard", "Zed"]);
});

test("an id-casing change surfaces as add + vanish with a duplicate name (the caller's invariants reject it)", () => {
  const existing = [{ name: "Fiddlesticks", id: "Fiddlesticks", positions: ["JUNGLE"] }];
  const ddragon = [{ id: "FiddleSticks", name: "Fiddlesticks" }];
  const { champions, added, vanished } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([["Fiddlesticks", ["JUNGLE"]]]) });
  assert.deepEqual(added, ["FiddleSticks"]);
  assert.deepEqual(vanished, ["Fiddlesticks"]);
  assert.equal(champions.length, 2);
  assert.equal(champions.filter((c) => c.name === "Fiddlesticks").length, 2);
});

test("merge proof (design § 8 step 2c): every refresh-owned field survives for every existing id and only new ids differ", () => {
  // a fixture pair shaped like the real file after the refresh
  const existing = [
    { name: "Ahri", id: "Ahri", positions: ["MIDDLE"] },
    { name: "Sylas", id: "Sylas", positions: ["MIDDLE", "JUNGLE", "SUPPORT"] },
    { name: "Vayne", id: "Vayne", positions: ["TOP", "BOTTOM"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP", "JUNGLE"] },
  ];
  const ddragon = [...existing.map(({ id, name }) => ({ id, name })), { id: "Brandnew", name: "Brandnew" }];
  const { champions, added } = mergeChampionRows({ existing, ddragon, merakiByName: meraki([["Vayne", ["BOTTOM", "TOP"]], ["Brandnew", ["TOP"]]]) });
  assert.deepEqual(added, ["Brandnew"]);
  assert.equal(champions.length, existing.length + added.length);
  for (const row of existing) {
    const merged = champions.find((c) => c.id === row.id);
    assert.deepEqual(merged.positions, row.positions, `${row.id} positions changed`);
  }
  assert.deepEqual(champions.find((c) => c.id === "Brandnew").positions, ["TOP"]);
});
