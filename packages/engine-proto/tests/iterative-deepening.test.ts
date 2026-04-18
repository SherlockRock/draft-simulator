import { describe, it, expect } from "vitest";
import { iterativeDeepeningSearch } from "../src/iterative-deepening.js";
import { createEmptyDraft } from "../src/draft-state.js";
import { TEST_CHAMPIONS, TEST_CHAMPION_IDS } from "./helpers.js";
import type { SearchContext } from "../src/types.js";

function makeCtx(overrides: Partial<SearchContext["config"]> = {}): SearchContext {
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
      branchWidth: 3,
      maxDepth: 4,
      broadDepth: 4,
      extensionTurnThreshold: 8,
      latencyBudgetMs: 5000,
      forcedMoves: [],
      ...overrides,
    },
    userSide: "blue",
  };
}

describe("iterativeDeepeningSearch", () => {
  it("returns a tree and meta with depthReached >= 1", () => {
    const state = createEmptyDraft();
    const ctx = makeCtx();
    const { tree, meta } = iterativeDeepeningSearch(state, TEST_CHAMPION_IDS, ctx);
    expect(tree).toBeDefined();
    expect(tree.children.length).toBeGreaterThan(0);
    expect(meta.depthReached).toBeGreaterThanOrEqual(1);
  });

  it("respects latency budget", () => {
    const state = createEmptyDraft();
    const ctx = makeCtx({ latencyBudgetMs: 100, maxDepth: 10, broadDepth: 10 });
    const start = performance.now();
    const { meta } = iterativeDeepeningSearch(state, TEST_CHAMPION_IDS, ctx);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(meta.computeTimeMs).toBeDefined();
  });

  it("deeper search evaluates more nodes", () => {
    const state = createEmptyDraft();
    const shallow = makeCtx({ maxDepth: 1, broadDepth: 1, latencyBudgetMs: 5000 });
    const deep = makeCtx({ maxDepth: 3, broadDepth: 3, latencyBudgetMs: 5000 });
    const shallowResult = iterativeDeepeningSearch(state, TEST_CHAMPION_IDS, shallow);
    const deepResult = iterativeDeepeningSearch(state, TEST_CHAMPION_IDS, deep);
    expect(deepResult.meta.nodesEvaluated).toBeGreaterThanOrEqual(shallowResult.meta.nodesEvaluated);
  });

  it("meta tracks nodesEvaluated and computeTimeMs", () => {
    const state = createEmptyDraft();
    const ctx = makeCtx();
    const { meta } = iterativeDeepeningSearch(state, TEST_CHAMPION_IDS, ctx);
    expect(meta.nodesEvaluated).toBeGreaterThan(0);
    expect(meta.computeTimeMs).toBeGreaterThan(0);
  });
});
