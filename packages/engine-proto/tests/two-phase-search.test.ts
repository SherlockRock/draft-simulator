import { describe, it, expect } from "vitest";
import { twoPhaseSearch } from "../src/two-phase-search.js";
import {
  emptyDraft,
  makeChampion,
  TEST_CHAMPIONS,
  TEST_CHAMPION_IDS,
} from "./helpers.js";
import type { SearchContext } from "../src/types.js";

const EXTENDED_TEST_CHAMPIONS = {
  ...TEST_CHAMPIONS,
  Maokai: makeChampion("Maokai", ["TOP", "SUPPORT"]),
  Sejuani: makeChampion("Sejuani", ["JUNGLE"]),
  Syndra: makeChampion("Syndra", ["MIDDLE"]),
  Xayah: makeChampion("Xayah", ["ADC"]),
  Rakan: makeChampion("Rakan", ["SUPPORT"]),
  Renekton: makeChampion("Renekton", ["TOP"]),
  Nidalee: makeChampion("Nidalee", ["JUNGLE"]),
};

const EXTENDED_TEST_CHAMPION_IDS = Object.keys(EXTENDED_TEST_CHAMPIONS);

function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    champions: TEST_CHAMPIONS,
    metaData: { winRates: {}, synergies: [], counters: {} },
    playerModel: {
      championTiers: { core: TEST_CHAMPION_IDS, playable: [], emergency: [] },
      weights: {},
    },
    opponentModel: {
      type: "meta",
      weights: Object.fromEntries(TEST_CHAMPION_IDS.map((id) => [id, 1 / TEST_CHAMPION_IDS.length])),
    },
    config: {
      branchWidth: 2,
      maxDepth: 2,
      broadDepth: 2,
      extensionTurnThreshold: 8,
      latencyBudgetMs: 5000,
      forcedMoves: [],
    },
    userSide: "blue",
    ...overrides,
  };
}

describe("twoPhaseSearch", () => {
  it("returns a tree and scenarios with ban arrays", () => {
    const state = emptyDraft();
    const ctx = makeCtx();
    const result = twoPhaseSearch(state, TEST_CHAMPION_IDS, ctx);
    expect(result.tree).toBeDefined();
    expect(result.scenarios.length).toBeGreaterThan(0);
    for (const s of result.scenarios) {
      expect(Array.isArray(s.blueBans)).toBe(true);
      expect(Array.isArray(s.redBans)).toBe(true);
    }
  });

  it("grafts extensions so scenario paths extend beyond broadDepth", () => {
    const state = emptyDraft();
    const ctx = makeCtx();
    const result = twoPhaseSearch(state, TEST_CHAMPION_IDS, ctx);
    const deepest = Math.max(...result.scenarios.map((s) => s.treePath.length));
    expect(deepest).toBeGreaterThan(2);
  });

  it("accumulates strategically meaningful picks when extension reaches pick1", () => {
    const state = emptyDraft();
    const ctx = makeCtx({
      champions: EXTENDED_TEST_CHAMPIONS,
      playerModel: {
        championTiers: {
          core: EXTENDED_TEST_CHAMPION_IDS,
          playable: [],
          emergency: [],
        },
        weights: {},
      },
      opponentModel: {
        type: "meta",
        weights: Object.fromEntries(
          EXTENDED_TEST_CHAMPION_IDS.map((id) => [id, 1 / EXTENDED_TEST_CHAMPION_IDS.length]),
        ),
      },
    });
    const result = twoPhaseSearch(state, EXTENDED_TEST_CHAMPION_IDS, ctx);
    const withPicks = result.scenarios.find(
      (s) => s.bluePicks.length > 0 || s.redPicks.length > 0,
    );
    expect(withPicks).toBeDefined();
  });
});
