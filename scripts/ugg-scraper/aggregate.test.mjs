import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCounters } from "./aggregate.mjs";

test("buildCounters normalizes by solo winrate", () => {
  const matchups = {
    "266": { TOP: [{ championId: 17, wins: 60, matches: 100, winRate: 0.60 }] },
  };
  const winrates = { Aatrox: { TOP: { wr: 0.50, n: 5000 } } };
  const idToAlias = { 266: "Aatrox", 17: "Teemo" };
  const result = buildCounters(matchups, winrates, idToAlias);
  assert.equal(result.Aatrox.Teemo, 0.10);
});

test("buildCounters drops matchups below sample threshold", () => {
  const matchups = {
    "266": { TOP: [{ championId: 17, wins: 5, matches: 10, winRate: 0.50 }] },
  };
  const winrates = { Aatrox: { TOP: { wr: 0.50, n: 5000 } } };
  const idToAlias = { 266: "Aatrox", 17: "Teemo" };
  const result = buildCounters(matchups, winrates, idToAlias, { minMatches: 30 });
  assert.equal(result.Aatrox, undefined);
});

test("buildCounters averages role-conflicting matchups by sample size", () => {
  const matchups = {
    "266": {
      TOP: [{ championId: 17, wins: 60, matches: 100, winRate: 0.60 }],
      JUNGLE: [{ championId: 17, wins: 30, matches: 100, winRate: 0.30 }],
    },
  };
  const winrates = {
    Aatrox: { TOP: { wr: 0.50 }, JUNGLE: { wr: 0.50 } },
  };
  const idToAlias = { 266: "Aatrox", 17: "Teemo" };
  const result = buildCounters(matchups, winrates, idToAlias);
  // (+0.10 * 100 + -0.20 * 100) / 200 = -0.05
  assert.equal(result.Aatrox.Teemo, -0.05);
});

test("buildCounters skips champions with no winrate entry", () => {
  const matchups = {
    "999": { TOP: [{ championId: 17, wins: 60, matches: 100, winRate: 0.60 }] },
  };
  const winrates = {};
  const idToAlias = { 999: "Unknown", 17: "Teemo" };
  const result = buildCounters(matchups, winrates, idToAlias);
  assert.deepEqual(result, {});
});

test("buildCounters skips matchups whose enemy alias is unknown", () => {
  const matchups = {
    "266": {
      TOP: [{ championId: 99999, wins: 60, matches: 100, winRate: 0.60 }],
    },
  };
  const winrates = { Aatrox: { TOP: { wr: 0.50 } } };
  const idToAlias = { 266: "Aatrox" };
  const result = buildCounters(matchups, winrates, idToAlias);
  assert.deepEqual(result, {});
});

test("buildCounters skips roles with no solo winrate", () => {
  const matchups = {
    "266": {
      MIDDLE: [{ championId: 17, wins: 60, matches: 100, winRate: 0.60 }],
    },
  };
  const winrates = { Aatrox: { TOP: { wr: 0.50 } } };
  const idToAlias = { 266: "Aatrox", 17: "Teemo" };
  const result = buildCounters(matchups, winrates, idToAlias);
  assert.deepEqual(result, {});
});
