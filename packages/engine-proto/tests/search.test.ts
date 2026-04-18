import { describe, it, expect } from "vitest";
import { search } from "../src/search.js";
import { createEmptyDraft, applyMove } from "../src/draft-state.js";
import { TEST_CHAMPIONS, TEST_CHAMPION_IDS } from "./helpers.js";
import type { SearchContext, TreeNode } from "../src/types.js";

function makeSearchCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    champions: TEST_CHAMPIONS,
    metaData: {
      winRates: {},
      synergies: [
        { tags: ["engage_initiator", "follow_up_cc"], bonus: 0.3, description: "" },
      ],
      counters: {},
    },
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

describe("search", () => {
  it("returns a tree with children at depth > 0", () => {
    const state = createEmptyDraft();
    const ctx = makeSearchCtx();
    const tree = search(state, TEST_CHAMPION_IDS, ctx);
    expect(tree.championIds).toEqual([]);
    expect(tree.children.length).toBeGreaterThan(0);
    expect(tree.children.length).toBeLessThanOrEqual(ctx.config.branchWidth);
  });

  it("tree children have valid champion IDs from the pool", () => {
    const state = createEmptyDraft();
    const ctx = makeSearchCtx();
    const tree = search(state, TEST_CHAMPION_IDS, ctx);
    for (const child of tree.children) {
      for (const championId of child.championIds) {
        expect(TEST_CHAMPION_IDS).toContain(championId);
      }
    }
  });

  it("children have correct side for the current turn", () => {
    const state = createEmptyDraft();
    const ctx = makeSearchCtx();
    const tree = search(state, TEST_CHAMPION_IDS, ctx);
    for (const child of tree.children) {
      expect(child.side).toBe("blue");
    }
  });

  it("does not pick the same champion twice in a branch", () => {
    const state = createEmptyDraft();
    const ctx = makeSearchCtx({ config: { ...makeSearchCtx().config, maxDepth: 4 } });
    const tree = search(state, TEST_CHAMPION_IDS, ctx);
    const championsInBranch: string[] = [];
    let node: TreeNode = tree;
    while (node.children.length > 0) {
      node = node.children[0];
      for (const championId of node.championIds) {
        expect(championsInBranch).not.toContain(championId);
        championsInBranch.push(championId);
      }
    }
  });

  it("children are sorted by score (best first for user turn)", () => {
    const state = createEmptyDraft();
    const ctx = makeSearchCtx({ config: { ...makeSearchCtx().config, maxDepth: 1 } });
    const tree = search(state, TEST_CHAMPION_IDS, ctx);
    if (tree.children.length >= 2) {
      for (let i = 0; i < tree.children.length - 1; i++) {
        expect(tree.children[i].scores.composite).toBeGreaterThanOrEqual(
          tree.children[i + 1].scores.composite,
        );
      }
    }
  });
});
