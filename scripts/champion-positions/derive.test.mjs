// scripts/champion-positions/derive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POSITIONS_THRESHOLD, MAX_PRIMARY_FLIPS, MAX_FEASIBILITY_DROP,
  derivePositions, ratesFromCorpus, ratesFromUgg, refreshPositions, diffPositions,
  buildProvenance, formatPositionsSource, evaluateGate, formatDiff,
} from "./derive.mjs";

test("the constants are the design's", () => {
  assert.equal(POSITIONS_THRESHOLD, 0.10);
  assert.equal(MAX_PRIMARY_FLIPS, 10);
  assert.equal(MAX_FEASIBILITY_DROP, 0.02);
});

test("derivePositions lists roles at or above the threshold, ordered by share", () => {
  const vayne = { TOP: 0.5677, JUNGLE: 0.0113, MIDDLE: 0.0344, BOTTOM: 0.3842, SUPPORT: 0.0024 };
  assert.deepEqual(derivePositions(vayne), ["TOP", "BOTTOM"]);
  const lux = { TOP: 0.005, JUNGLE: 0.0, MIDDLE: 0.34, BOTTOM: 0.26, SUPPORT: 0.39 };
  assert.deepEqual(derivePositions(lux), ["SUPPORT", "MIDDLE", "BOTTOM"]);
});

test("derivePositions keeps the argmax alone when nothing reaches the threshold", () => {
  const spread = { TOP: 0.09, JUNGLE: 0.09, MIDDLE: 0.09, BOTTOM: 0.09, SUPPORT: 0.09 };
  assert.deepEqual(derivePositions(spread, 0.5), ["TOP"]);
});

test("derivePositions breaks exact ties in canonical vocabulary order (deterministic output)", () => {
  const tie = { TOP: 0.3, JUNGLE: 0.0, MIDDLE: 0.3, BOTTOM: 0.4, SUPPORT: 0.0 };
  assert.deepEqual(derivePositions(tie), ["BOTTOM", "TOP", "MIDDLE"]);
});

test("derivePositions treats a missing role key as zero and includes exactly-threshold shares", () => {
  assert.deepEqual(derivePositions({ MIDDLE: 0.9, JUNGLE: 0.1 }), ["MIDDLE", "JUNGLE"]);
});

test("ratesFromCorpus reads meta_roles, keys by alias, and counts games as picks / 10", () => {
  const doc = {
    "67": { alias: "Vayne", games: 20, roles: { TOP: 0.5, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.5, UTILITY: 0 },
            meta_roles: { TOP: 0.5, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.5, SUPPORT: 0 } },
    "103": { alias: "Ahri", games: 30, roles: { MIDDLE: 1 }, meta_roles: { MIDDLE: 1 } },
  };
  const { rates, games, kind } = ratesFromCorpus(doc);
  assert.equal(kind, "corpus");
  assert.equal(games, 5);
  assert.deepEqual(rates.get("Vayne"), { TOP: 0.5, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.5, SUPPORT: 0 });
  assert.equal(rates.get("Ahri").MIDDLE, 1);
});

test("ratesFromCorpus refuses a file without the meta_roles block (the roles block says UTILITY)", () => {
  const doc = { "67": { alias: "Vayne", games: 10, roles: { UTILITY: 1 } } };
  assert.throws(() => ratesFromCorpus(doc), /meta_roles/);
});

test("ratesFromCorpus refuses a pick total that is not a multiple of ten", () => {
  const doc = { "67": { alias: "Vayne", games: 7, roles: {}, meta_roles: { TOP: 1 } } };
  assert.throws(() => ratesFromCorpus(doc), /multiple of 10/);
});

test("ratesFromUgg turns per-role match counts into shares and sums the counts", () => {
  const doc = { patch: "16_8", byChampion: {
    Vayne: { BOTTOM: { wr: 0.5, n: 300 }, TOP: { wr: 0.5, n: 100 } },
    Ahri: { MIDDLE: { wr: 0.5, n: 50 } },
  } };
  const { rates, games, kind } = ratesFromUgg(doc);
  assert.equal(kind, "ugg");
  assert.equal(games, 450);
  assert.deepEqual(rates.get("Vayne"), { TOP: 0.25, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.75, SUPPORT: 0 });
  assert.equal(rates.has("Nobody"), false);
});

test("refreshPositions rewrites only positions, keeps order and other fields, and keeps absent champions", () => {
  const rows = [
    { name: "Ahri", id: "Ahri", positions: ["MIDDLE"], extra: 1 },
    { name: "Vayne", id: "Vayne", positions: ["BOTTOM", "TOP"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP", "JUNGLE"] },
  ];
  const rates = new Map([
    ["Ahri", { MIDDLE: 0.93, TOP: 0.04, BOTTOM: 0.03 }],
    ["Vayne", { TOP: 0.57, BOTTOM: 0.38, MIDDLE: 0.03 }],
  ]);
  const { rows: out, kept } = refreshPositions(rows, rates);
  assert.deepEqual(out.map((r) => r.id), ["Ahri", "Vayne", "Zaahen"]);
  assert.deepEqual(out[0], { name: "Ahri", id: "Ahri", positions: ["MIDDLE"], extra: 1 });
  assert.deepEqual(out[1].positions, ["TOP", "BOTTOM"]);
  assert.deepEqual(out[2].positions, ["TOP", "JUNGLE"]);
  assert.deepEqual(kept, ["Zaahen"]);
  assert.deepEqual(rows[1].positions, ["BOTTOM", "TOP"], "input is not mutated");
});

test("diffPositions reports primary flips, lost and gained pairs, changed sets and means", () => {
  const before = [
    { id: "Vayne", positions: ["BOTTOM", "TOP"] },
    { id: "Ashe", positions: ["BOTTOM", "SUPPORT"] },
    { id: "Sylas", positions: ["MIDDLE", "TOP"] },
    { id: "Zaahen", positions: [] },
  ];
  const after = [
    { id: "Vayne", positions: ["TOP", "BOTTOM"] },
    { id: "Ashe", positions: ["BOTTOM"] },
    { id: "Sylas", positions: ["MIDDLE", "JUNGLE", "SUPPORT"] },
    { id: "Zaahen", positions: ["TOP"] },
  ];
  const d = diffPositions(before, after);
  assert.deepEqual(d.primaryFlips, [{ id: "Vayne", from: "BOTTOM", to: "TOP" }, { id: "Zaahen", from: null, to: "TOP" }]);
  assert.deepEqual(d.lost, [{ id: "Ashe", role: "SUPPORT" }, { id: "Sylas", role: "TOP" }]);
  assert.deepEqual(d.gained, [{ id: "Sylas", role: "JUNGLE" }, { id: "Sylas", role: "SUPPORT" }, { id: "Zaahen", role: "TOP" }]);
  assert.equal(d.changedSets, 3);
  assert.equal(d.meanBefore, 1.5);
  assert.equal(d.meanAfter, 1.75);
});

test("diffPositions refuses misaligned inputs (the refresh never adds, removes or reorders)", () => {
  assert.throws(() => diffPositions([{ id: "A", positions: ["TOP"] }], [{ id: "B", positions: ["TOP"] }]), /aligned/);
});

test("buildProvenance writes the block in the documented key order and omits an absent feasibility", () => {
  const p = buildProvenance({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1,
                              generatedAt: "2026-09-05T00:00:00.000Z", feasibility: undefined });
  assert.deepEqual(Object.keys(p), ["kind", "patches", "games", "threshold", "generatedAt"]);
  const q = buildProvenance({ kind: "corpus", patches: ["16.16"], games: 1, threshold: 0.1,
                              generatedAt: "x", feasibility: { sets: 10, bothSides: 0.5 } });
  assert.deepEqual(q.feasibility, { sets: 10, bothSides: 0.5 });
  const u = buildProvenance({ kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x" });
  assert.deepEqual(Object.keys(u), ["kind", "patches", "games", "gamesUnit", "unmeasuredAtParity", "threshold", "generatedAt"]);
});

test("formatPositionsSource renders every field an operator needs, including a carried-forward feasibility", () => {
  assert.equal(formatPositionsSource(undefined), "none recorded (Meraki verbatim)");
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "2026-09-05T10:00:00.000Z", feasibility: { sets: 34159, bothSides: 0.785 } }),
    "corpus patches=16.15,16.16 threshold=0.1 generated=2026-09-05T10:00:00.000Z feasibility=0.785",
  );
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.17"], games: 1, threshold: 0.1, generatedAt: "2026-10-01T00:00:00.000Z",
                            feasibility: { sets: 34159, bothSides: 0.785, carriedFrom: { generatedAt: "2026-09-05T10:00:00.000Z", kind: "corpus" } } }),
    "corpus patches=16.17 threshold=0.1 generated=2026-10-01T00:00:00.000Z feasibility=0.785 (carried from 2026-09-05T10:00:00.000Z)",
  );
  assert.equal(
    formatPositionsSource({ kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x" }),
    "ugg patches=16_8 threshold=0.1 generated=x feasibility=unmeasured [source unmeasured at parity]",
  );
  // a corpus block with no feasibility (first run with --skip-feasibility): "unmeasured" must not depend on the parity flag
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "x" }),
    "corpus patches=16.15,16.16 threshold=0.1 generated=x feasibility=unmeasured",
  );
});

test("evaluateGate is not armed on the first run, whatever the flip count", () => {
  const g = evaluateGate({ previous: undefined, primaryFlips: 37, feasibility: { sets: 1, bothSides: 0.785 }, force: false });
  assert.deepEqual(g, { armed: false, abort: false, reasons: [] });
});

test("evaluateGate aborts a recurring run on more than MAX_PRIMARY_FLIPS flips", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 11, feasibility: { sets: 1, bothSides: 0.79 }, force: false });
  assert.equal(g.armed, true);
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /11 primary flips > 10/);
  assert.equal(evaluateGate({ previous, primaryFlips: 10, feasibility: { sets: 1, bothSides: 0.79 }, force: false }).abort, false);
});

test("evaluateGate aborts a recurring run on a feasibility drop of more than MAX_FEASIBILITY_DROP", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.76 }, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /0.760 is 0.025 below the previous 0.785/);
  assert.equal(evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.766 }, force: false }).abort, false);
});

test("evaluateGate cannot compare feasibility when the PREVIOUS run lacks it, and says so", () => {
  const previous = { kind: "corpus" };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.5 }, force: false });
  assert.equal(g.abort, false);
  assert.match(g.reasons[0], /not compared/);
});

test("evaluateGate refuses a recurring run that cannot measure feasibility when the previous run could (the gate must not silently disarm)", () => {
  const previous = { kind: "corpus", generatedAt: "2026-09-05T00:00:00.000Z", feasibility: { sets: 34159, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: undefined, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /feasibility unmeasured on this run while the previous run recorded 0\.785/);
  const forced = evaluateGate({ previous, primaryFlips: 3, feasibility: undefined, force: true });
  assert.equal(forced.abort, false);
  assert.match(forced.reasons.join("\n"), /overridden by --force/);
});

test("evaluateGate says when the number it is comparing against was carried forward, never measured", () => {
  const previous = { kind: "corpus", generatedAt: "2026-10-01T00:00:00.000Z",
                     feasibility: { sets: 1, bothSides: 0.785, carriedFrom: { generatedAt: "2026-09-05T10:00:00.000Z", kind: "corpus" } } };
  const g = evaluateGate({ previous, primaryFlips: 0, feasibility: { sets: 1, bothSides: 0.70 }, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /carried from 2026-09-05T10:00:00.000Z, never measured for that table/);
});

test("evaluateGate reports but does not abort under --force", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 40, feasibility: { sets: 1, bothSides: 0.5 }, force: true });
  assert.equal(g.abort, false);
  assert.equal(g.reasons.length, 3);   // flips, feasibility drop, the override note
  assert.match(g.reasons.join("\n"), /overridden by --force/);
});

test("formatDiff names each flip with its rates, the lost and gained pairs, and the kept champions", () => {
  const diff = {
    primaryFlips: [{ id: "Vayne", from: "BOTTOM", to: "TOP" }],
    lost: [{ id: "Ashe", role: "SUPPORT" }],
    gained: [{ id: "Sylas", role: "JUNGLE" }],
    changedSets: 3, meanBefore: 1.4, meanAfter: 1.72,
  };
  const rates = new Map([["Vayne", { TOP: 0.5677, BOTTOM: 0.3842, MIDDLE: 0.0344, JUNGLE: 0.0113, SUPPORT: 0.0024 }]]);
  const text = formatDiff(diff, rates, ["Zaahen"]);
  assert.match(text, /primary flips \(1\)/);
  assert.match(text, /Vayne +BOTTOM +-> TOP +\(TOP 0\.57, BOTTOM 0\.38\)/);
  assert.match(text, /roles lost \(1\): Ashe SUPPORT/);
  assert.match(text, /roles gained \(1\): Sylas JUNGLE/);
  assert.match(text, /kept \(no source data\) \(1\): Zaahen/);
  assert.match(text, /mean positions per champion 1\.40 -> 1\.72/);
});
