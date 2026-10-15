// scripts/champion-positions/winrate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINRATE_MIN_COVERED_MASS, formatWinRateReport, shareWeightedWinRate } from "./winrate.mjs";

// u.gg rows use the meta vocabulary (BOTTOM / SUPPORT), like champion-meta's positionShares.
const PANTHEON = { TOP: { wr: 0.51, n: 9000 }, SUPPORT: { wr: 0.49, n: 8000 }, MIDDLE: { wr: 0.47, n: 900 } };
const PANTHEON_SHARES = { TOP: 0.392, JUNGLE: 0.108, MIDDLE: 0.112, BOTTOM: 0.013, SUPPORT: 0.376 };

test("the share-weighted mean over the roles u.gg has data for, renormalised to the mass it covers", () => {
  const r = shareWeightedWinRate(PANTHEON, ["TOP", "SUPPORT", "MIDDLE", "JUNGLE"], PANTHEON_SHARES);
  const mass = 0.392 + 0.376 + 0.112;
  assert.equal(r.rule, "shares");
  assert.equal(r.coveredMass, mass);
  assert.ok(Math.abs(r.winRate - (0.392 * 0.51 + 0.376 * 0.49 + 0.112 * 0.47) / mass) < 1e-12);
  // Not the first listed role's 0.51, and not the unweighted mean either.
  assert.notEqual(r.winRate, 0.51);
  assert.ok(Math.abs(r.winRate - (0.51 + 0.49 + 0.47) / 3) > 1e-6);
});

test("a role without u.gg data carries no weight; a role without a share counts 0", () => {
  // JUNGLE has a share (0.108) but no u.gg row: outside the mass. A legacy listed-key map carries
  // only the listed roles: SUPPORT's absent share is 0, so TOP alone decides.
  const r = shareWeightedWinRate({ TOP: { wr: 0.51 }, SUPPORT: { wr: 0.49 } }, ["TOP", "SUPPORT"], { TOP: 0.6 });
  assert.equal(r.rule, "shares");
  assert.equal(r.coveredMass, 0.6);
  assert.equal(r.winRate, 0.51);
});

test(`covered mass below ${WINRATE_MIN_COVERED_MASS} falls back to today's rule: the first listed position with data`, () => {
  assert.equal(WINRATE_MIN_COVERED_MASS, 0.5);
  // u.gg knows MIDDLE and BOTTOM only; the shares put 0.11 + 0.01 there.
  const r = shareWeightedWinRate({ MIDDLE: { wr: 0.47 }, BOTTOM: { wr: 0.45 } }, ["TOP", "SUPPORT", "MIDDLE"], PANTHEON_SHARES);
  assert.equal(r.rule, "listed");
  assert.equal(r.winRate, 0.47);
  assert.ok(Math.abs(r.coveredMass - 0.125) < 1e-12);
});

test("exactly the threshold uses the mean (>= 0.5 — design D5 / Codex R2)", () => {
  const r = shareWeightedWinRate({ TOP: { wr: 0.52 }, MIDDLE: { wr: 0.48 } }, ["TOP"], { TOP: 0.3, MIDDLE: 0.2, JUNGLE: 0.5 });
  assert.equal(r.rule, "shares");
  assert.ok(Math.abs(r.coveredMass - 0.5) < 1e-12);
  assert.ok(Math.abs(r.winRate - (0.3 * 0.52 + 0.2 * 0.48) / 0.5) < 1e-12);
});

test("no shares at all (a hand row) is today's rule; no listed role with data falls to any role; no data is 0", () => {
  assert.deepEqual(shareWeightedWinRate(PANTHEON, ["TOP", "SUPPORT"], undefined), { winRate: 0.51, rule: "listed", coveredMass: 0 });
  assert.deepEqual(shareWeightedWinRate({ MIDDLE: { wr: 0.47 } }, ["TOP"], undefined), { winRate: 0.47, rule: "any", coveredMass: 0 });
  assert.deepEqual(shareWeightedWinRate({ MIDDLE: { wr: 0.47 } }, [], undefined), { winRate: 0.47, rule: "any", coveredMass: 0 });
  assert.deepEqual(shareWeightedWinRate(undefined, ["TOP"], PANTHEON_SHARES), { winRate: 0, rule: "none", coveredMass: 0 });
  assert.deepEqual(shareWeightedWinRate({}, ["TOP"], PANTHEON_SHARES), { winRate: 0, rule: "none", coveredMass: 0 });
});

test("the report counts the rules and names the largest moves against the previous compile", () => {
  const rows = [
    { id: "Pantheon", winRate: 0.5, rule: "shares", coveredMass: 0.88, previous: 0.51 },
    { id: "Jinx", winRate: 0.52, rule: "shares", coveredMass: 0.998, previous: 0.52 },
    { id: "Locke", winRate: 0.5, rule: "listed", coveredMass: 0.1, previous: 0.46 },
    { id: "Zaahen", winRate: 0, rule: "none", coveredMass: 0 },
  ];
  const lines = formatWinRateReport(rows, { largest: 1 });
  assert.equal(lines[0], "winRate: share-weighted mean on 2 champions; today's rule on 2 (covered mass < 0.5 or no shares: listed 1, any 0, none 1)");
  assert.equal(lines[1], "winRate moved on 2 of 4 champions against the previous compile");
  assert.equal(lines[2], "  Locke: 0.4600 -> 0.5000 (+0.0400, mass 0.100, listed)");
  assert.equal(lines.length, 3);
  // Without a previous compile the report is the count line alone.
  assert.equal(formatWinRateReport(rows.map(({ previous: _p, ...row }) => row)).length, 1);
});
