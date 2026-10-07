// scripts/champion-positions/invariants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { META_POSITIONS, assertChampionRows, positionSharesProblems } from "./invariants.mjs";

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

// ---- positionShares (engine-role-grade design § 1, G10) ----

test("positionShares absent is allowed (a hand-entered champion)", () => {
  assert.deepEqual(positionSharesProblems({ id: "Zaahen", positions: ["TOP"] }, "t"), []);
  assert.equal(assertChampionRows([{ id: "Zaahen", name: "Zaahen", positions: ["TOP"] }], { label: "t" }), undefined);
});

test("positionShares with keys = the positions set, values in (0, 1] and the maximum at positions[0] passes; ties allowed", () => {
  const rows = [
    { id: "Vayne", name: "Vayne", positions: ["TOP", "BOTTOM"], positionShares: { TOP: 0.568, BOTTOM: 0.384 } },
    { id: "Tie", name: "Tie", positions: ["MIDDLE", "TOP"], positionShares: { MIDDLE: 0.5, TOP: 0.5 } },
    { id: "Sole", name: "Sole", positions: ["JUNGLE"], positionShares: { JUNGLE: 1 } },
  ];
  assert.equal(assertChampionRows(rows, { label: "t" }), undefined);
});

test("positionShares refuses a key outside positions and a missing key for a listed role", () => {
  const extra = { id: "Ahri", name: "Ahri", positions: ["MIDDLE"], positionShares: { MIDDLE: 0.9, TOP: 0.1 } };
  assert.throws(() => assertChampionRows([extra], { label: "t" }), /Ahri positionShares names TOP, which positions does not list/);
  const missing = { id: "Ahri", name: "Ahri", positions: ["MIDDLE", "TOP"], positionShares: { MIDDLE: 0.9 } };
  assert.throws(() => assertChampionRows([missing], { label: "t" }), /Ahri positionShares lacks the listed role TOP/);
});

test("positionShares refuses a value above 1, a zero, a non-number, and a non-object", () => {
  const over = { id: "A", name: "A", positions: ["TOP"], positionShares: { TOP: 1.2 } };
  assert.throws(() => assertChampionRows([over], { label: "t" }), /A positionShares\.TOP = 1\.2 is not a finite number in \(0, 1\]/);
  const zero = { id: "B", name: "B", positions: ["TOP"], positionShares: { TOP: 0 } };
  assert.throws(() => assertChampionRows([zero], { label: "t" }), /B positionShares\.TOP = 0 is not/);
  const text = { id: "C", name: "C", positions: ["TOP"], positionShares: { TOP: "0.5" } };
  assert.throws(() => assertChampionRows([text], { label: "t" }), /C positionShares\.TOP = 0\.5 is not/);
  const list = { id: "D", name: "D", positions: ["TOP"], positionShares: [0.5] };
  assert.throws(() => assertChampionRows([list], { label: "t" }), /D positionShares is not an object keyed by role/);
});

test("positionShares refuses a non-maximal primary (a reordered-primary override)", () => {
  const row = { id: "Camille", name: "Camille", positions: ["SUPPORT", "TOP"], positionShares: { SUPPORT: 0.4, TOP: 0.56 } };
  assert.throws(() => assertChampionRows([row], { label: "t" }), /Camille positionShares\.TOP = 0\.56 exceeds the primary SUPPORT's 0\.4/);
});

test("positionShares problems are reported beside the positions problems, not instead of them", () => {
  const row = { id: "E", name: "E", positions: ["UTILITY"], positionShares: { TOP: 0.5 } };
  assert.throws(() => assertChampionRows([row], { label: "t" }), (err) => {
    assert.match(err.message, /E position UTILITY/);
    assert.match(err.message, /E positionShares names TOP/);
    return true;
  });
});
