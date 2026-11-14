// scripts/champion-positions/invariants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { META_POSITIONS, assertChampionRows, positionSharesProblems, playableProblems, ownShareFloorProblems } from "./invariants.mjs";

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

// ---- positionShares (champion-role-shares design § 4.1: five keys, [0, 1], max > 0, no ordering rule;
//      the legacy listed-key shape of the 2026-09-05 frozen tables is accepted input) ----

test("positionShares absent is allowed (a hand-entered champion)", () => {
  assert.deepEqual(positionSharesProblems({ id: "Zaahen", positions: ["TOP"] }, "t"), []);
  assert.equal(assertChampionRows([{ id: "Zaahen", name: "Zaahen", positions: ["TOP"] }], { label: "t" }), undefined);
});

test("positionShares with all five roles in [0, 1] passes whatever the order of positions — zeros and a non-maximal first position included", () => {
  const rows = [
    { id: "Vayne", name: "Vayne", positions: ["TOP", "BOTTOM"], positionShares: { TOP: 0.568, JUNGLE: 0.011, MIDDLE: 0.034, BOTTOM: 0.384, SUPPORT: 0.002 } },
    { id: "Thresh", name: "Thresh", positions: ["SUPPORT"], positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 1 } },
    // An override reordered Camille's positions: no ordering invariant on a stored row (judge I2).
    { id: "Camille", name: "Camille", positions: ["SUPPORT", "TOP"], positionShares: { TOP: 0.56, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.44 } },
    { id: "Tie", name: "Tie", positions: ["MIDDLE", "TOP"], positionShares: { TOP: 0.5, JUNGLE: 0, MIDDLE: 0.5, BOTTOM: 0, SUPPORT: 0 } },
  ];
  assert.equal(assertChampionRows(rows, { label: "t" }), undefined);
});

test("positionShares in the legacy listed-key shape (keys = exactly the positions set) is accepted", () => {
  const rows = [
    { id: "Vayne", name: "Vayne", positions: ["TOP", "BOTTOM"], positionShares: { TOP: 0.568, BOTTOM: 0.384 } },
    { id: "Sole", name: "Sole", positions: ["JUNGLE"], positionShares: { JUNGLE: 1 } },
    { id: "Camille", name: "Camille", positions: ["SUPPORT", "TOP"], positionShares: { SUPPORT: 0.4, TOP: 0.56 } },
  ];
  assert.equal(assertChampionRows(rows, { label: "t" }), undefined);
});

test("positionShares refuses a key set that is neither the five roles nor exactly the listed ones", () => {
  const extra = { id: "Ahri", name: "Ahri", positions: ["MIDDLE"], positionShares: { MIDDLE: 0.9, TOP: 0.1 } };
  assert.throws(() => assertChampionRows([extra], { label: "t" }), /Ahri positionShares keys \[MIDDLE,TOP\] are neither the five roles nor exactly the listed positions \[MIDDLE\]/);
  const missing = { id: "Ahri", name: "Ahri", positions: ["MIDDLE", "TOP"], positionShares: { MIDDLE: 0.9 } };
  assert.throws(() => assertChampionRows([missing], { label: "t" }), /Ahri positionShares keys \[MIDDLE\] are neither/);
  const four = { id: "Ahri", name: "Ahri", positions: ["MIDDLE"], positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0.9, BOTTOM: 0.1 } };
  assert.throws(() => assertChampionRows([four], { label: "t" }), /Ahri positionShares keys \[TOP,JUNGLE,MIDDLE,BOTTOM\] are neither/);
  const utility = { id: "Ahri", name: "Ahri", positions: ["MIDDLE"], positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0.9, BOTTOM: 0, UTILITY: 0.1 } };
  assert.throws(() => assertChampionRows([utility], { label: "t" }), /Ahri positionShares names UTILITY, which is not one of TOP\/JUNGLE\/MIDDLE\/BOTTOM\/SUPPORT/);
});

test("positionShares refuses a value above 1, a negative one, a non-number, a non-object, and an all-zero row", () => {
  const five = (over) => ({ TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0, ...over });
  const over = { id: "A", name: "A", positions: ["TOP"], positionShares: five({ TOP: 1.2 }) };
  assert.throws(() => assertChampionRows([over], { label: "t" }), /A positionShares\.TOP = 1\.2 is not a finite number in \[0, 1\]/);
  const negative = { id: "B", name: "B", positions: ["TOP"], positionShares: five({ TOP: -0.1 }) };
  assert.throws(() => assertChampionRows([negative], { label: "t" }), /B positionShares\.TOP = -0\.1 is not/);
  const text = { id: "C", name: "C", positions: ["TOP"], positionShares: five({ TOP: "0.5" }) };
  assert.throws(() => assertChampionRows([text], { label: "t" }), /C positionShares\.TOP = 0\.5 is not/);
  const list = { id: "D", name: "D", positions: ["TOP"], positionShares: [0.5] };
  assert.throws(() => assertChampionRows([list], { label: "t" }), /D positionShares is not an object keyed by role/);
  // max(shares) > 0 (Codex r3): an all-zero row would divide the factor and the grade by zero.
  const zeros = { id: "F", name: "F", positions: ["TOP"], positionShares: five({}) };
  assert.throws(() => assertChampionRows([zeros], { label: "t" }), /F positionShares are all zero — the factor and the grade divide by the largest share/);
  const legacyZero = { id: "G", name: "G", positions: ["TOP"], positionShares: { TOP: 0 } };
  assert.throws(() => assertChampionRows([legacyZero], { label: "t" }), /G positionShares are all zero/);
});

test("positionShares problems are reported beside the positions problems, not instead of them", () => {
  const row = { id: "E", name: "E", positions: ["UTILITY"], positionShares: { TOP: 0.5 } };
  assert.throws(() => assertChampionRows([row], { label: "t" }), (err) => {
    assert.match(err.message, /E position UTILITY/);
    assert.match(err.message, /E positionShares keys \[TOP\] are neither/);
    return true;
  });
});

// ---- playable (champion-role-shares design § 4.1) ----

test("playable absent is allowed; present it is a non-empty set of vocabulary roles that contains every position", () => {
  assert.deepEqual(playableProblems({ id: "Zaahen", positions: ["TOP"] }, "t"), []);
  const rows = [
    { id: "Kaisa", name: "Kaisa", positions: ["BOTTOM"], playable: ["TOP", "BOTTOM"] },
    { id: "Thresh", name: "Thresh", positions: ["SUPPORT"], playable: ["SUPPORT"] },
    { id: "Pantheon", name: "Pantheon", positions: ["TOP", "SUPPORT", "MIDDLE", "JUNGLE"], playable: ["JUNGLE", "MIDDLE", "TOP", "SUPPORT"] },
  ];
  assert.equal(assertChampionRows(rows, { label: "t" }), undefined);
});

test("playable refuses a non-array, a vocabulary miss, a duplicate, an empty list, and a listed position it lacks", () => {
  const notArray = { id: "A", name: "A", positions: ["TOP"], playable: "TOP" };
  assert.throws(() => assertChampionRows([notArray], { label: "t" }), /A playable is not an array/);
  const utility = { id: "B", name: "B", positions: ["SUPPORT"], playable: ["SUPPORT", "UTILITY"] };
  assert.throws(() => assertChampionRows([utility], { label: "t" }), /B playable role UTILITY is not one of TOP\/JUNGLE\/MIDDLE\/BOTTOM\/SUPPORT/);
  const dup = { id: "C", name: "C", positions: ["TOP"], playable: ["TOP", "TOP"] };
  assert.throws(() => assertChampionRows([dup], { label: "t" }), /C duplicate playable role TOP/);
  const empty = { id: "D", name: "D", positions: ["TOP"], playable: [] };
  assert.throws(() => assertChampionRows([empty], { label: "t" }), /D playable is empty/);
  // The rule the engine's fallback depends on: positions ⊆ playable (a narrowing override would prune a listed role).
  const narrow = { id: "Syndra", name: "Syndra", positions: ["MIDDLE", "BOTTOM"], playable: ["MIDDLE"] };
  assert.throws(() => assertChampionRows([narrow], { label: "t" }), /Syndra playable lacks the listed position BOTTOM/);
});

// ---- the own-games floor (engine slice B, S1/F2; design T29) ----

test("T29 ownShareFloorProblems flags a non-listed playable role stored under the floor, and nothing else", () => {
  const sh = (o) => ({ TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.9, SUPPORT: 0, ...o });
  const row = (playable, o, positions = ["BOTTOM"]) => ({ id: "Kaisa", positions, playable, positionShares: sh(o) });
  const bad = ownShareFloorProblems(row(["TOP", "BOTTOM"], { TOP: 0.019 }), "t", 0.02);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /t: Kaisa playable role TOP holds 0\.019 of the champion's games, under the 0\.02 floor/);
  assert.deepEqual(ownShareFloorProblems(row(["TOP", "BOTTOM"], { TOP: 0.02 }), "t", 0.02), [], "0.020 passes");
  assert.deepEqual(ownShareFloorProblems(row(["TOP", "BOTTOM"], { BOTTOM: 0.01 }, ["TOP", "BOTTOM"]), "t", 0.02), [], "a listed role at 0.010 passes");
  assert.deepEqual(ownShareFloorProblems({ id: "X", positions: ["TOP"], playable: ["TOP", "JUNGLE"] }, "t", 0.02), [], "no shares: skipped");
  assert.deepEqual(ownShareFloorProblems({ id: "X", positions: ["TOP"], playable: ["TOP", "JUNGLE"], positionShares: { TOP: 1 } }, "t", 0.02), [], "not five shares: skipped");
  assert.deepEqual(ownShareFloorProblems({ id: "X", positions: ["TOP"], positionShares: sh({}) }, "t", 0.02), [], "no playable: skipped");
  // Kept apart from playableProblems: a widening override that the floor would refuse is still a legal playable set.
  const widened = row(["TOP", "BOTTOM"], { TOP: 0.019 });
  assert.deepEqual(playableProblems(widened, "t"), []);
  assert.doesNotThrow(() => assertChampionRows([{ ...widened, name: "Kaisa" }], { label: "t" }));
});
