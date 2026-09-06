// scripts/champion-positions/invariants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { META_POSITIONS, assertChampionRows } from "./invariants.mjs";

const ok = [
  { id: "Ahri", name: "Ahri", positions: ["MIDDLE"] },
  { id: "Vayne", name: "Vayne", positions: ["TOP", "BOTTOM"] },
];

test("META_POSITIONS is the engine vocabulary in canonical order", () => {
  assert.deepEqual([...META_POSITIONS], ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"]);
});

test("valid rows pass and return undefined", () => {
  assert.equal(assertChampionRows(ok, { label: "t", expectedCount: 2 }), undefined);
});

test("UTILITY is rejected — it fails engine construction", () => {
  const rows = [{ id: "Lulu", name: "Lulu", positions: ["UTILITY"] }];
  assert.throws(() => assertChampionRows(rows, { label: "t" }), /Lulu.*UTILITY/);
});

test("an empty positions list is rejected by default", () => {
  const rows = [{ id: "Zaahen", name: "Zaahen", positions: [] }];
  assert.throws(() => assertChampionRows(rows, { label: "t" }), /Zaahen.*no positions/);
});

test("an empty positions list is allowed when requirePositions is false", () => {
  const rows = [{ id: "Zaahen", name: "Zaahen", positions: [] }];
  assert.equal(assertChampionRows(rows, { label: "t", requirePositions: false }), undefined);
});

test("a duplicate role inside one list is rejected", () => {
  const rows = [{ id: "Ahri", name: "Ahri", positions: ["MIDDLE", "MIDDLE"] }];
  assert.throws(() => assertChampionRows(rows, { label: "t" }), /Ahri.*duplicate position MIDDLE/);
});

test("duplicate ids and duplicate names are both rejected (the FiddleSticks add+drop shape)", () => {
  const rows = [
    { id: "FiddleSticks", name: "Fiddlesticks", positions: ["JUNGLE"] },
    { id: "Fiddlesticks", name: "Fiddlesticks", positions: ["JUNGLE"] },
  ];
  assert.throws(() => assertChampionRows(rows, { label: "t" }), /duplicate name Fiddlesticks/);
  const sameId = [
    { id: "Ahri", name: "Ahri", positions: ["MIDDLE"] },
    { id: "Ahri", name: "Ahri2", positions: ["MIDDLE"] },
  ];
  assert.throws(() => assertChampionRows(sameId, { label: "t" }), /duplicate id Ahri/);
});

test("a count mismatch is rejected and the message names both numbers", () => {
  assert.throws(() => assertChampionRows(ok, { label: "t", expectedCount: 3 }), /2 champions, expected 3/);
});

test("every violation is reported, not just the first", () => {
  const rows = [
    { id: "A", name: "A", positions: ["UTILITY"] },
    { id: "B", name: "B", positions: [] },
  ];
  assert.throws(() => assertChampionRows(rows, { label: "t" }), (err) => {
    assert.match(err.message, /A.*UTILITY/);
    assert.match(err.message, /B.*no positions/);
    return true;
  });
});
