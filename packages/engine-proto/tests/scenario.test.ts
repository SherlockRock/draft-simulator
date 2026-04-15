import { describe, it, expect } from "vitest";
import { extractScenarios, collectLeaves, computeFeatureVector, labelScenario } from "../src/scenario.js";
import { TEST_CHAMPIONS } from "./helpers.js";
import type { TreeNode, ScoreSet } from "../src/types.js";

const ZERO_SCORES: ScoreSet = {
  composite: 0, compStrength: 0, informationValue: 0, flexRetention: 0, revealCost: 0,
};

function makeTree(): TreeNode {
  return {
    championId: null, scores: ZERO_SCORES, assignmentDistribution: [],
    side: null, slot: null, userInjected: false,
    children: [
      {
        championId: "Aatrox", scores: { ...ZERO_SCORES, composite: 0.8 },
        assignmentDistribution: [], side: "blue", slot: 0, userInjected: false,
        children: [
          {
            championId: "LeeSin", scores: { ...ZERO_SCORES, composite: 0.7 },
            assignmentDistribution: [], side: "red", slot: 1, userInjected: false,
            children: [],
          },
          {
            championId: "Ahri", scores: { ...ZERO_SCORES, composite: 0.6 },
            assignmentDistribution: [], side: "red", slot: 1, userInjected: false,
            children: [],
          },
        ],
      },
      {
        championId: "Jinx", scores: { ...ZERO_SCORES, composite: 0.5 },
        assignmentDistribution: [], side: "blue", slot: 0, userInjected: false,
        children: [
          {
            championId: "Leona", scores: { ...ZERO_SCORES, composite: 0.4 },
            assignmentDistribution: [], side: "red", slot: 1, userInjected: false,
            children: [],
          },
        ],
      },
    ],
  };
}

describe("collectLeaves", () => {
  it("collects all leaf nodes with their tree paths", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    expect(leaves).toHaveLength(3);
    for (const leaf of leaves) {
      expect(leaf.path.length).toBeGreaterThan(0);
    }
  });
});

describe("computeFeatureVector", () => {
  it("returns a numeric array from champion picks", () => {
    const vec = computeFeatureVector(["Aatrox", "Ahri"], TEST_CHAMPIONS);
    expect(vec.length).toBeGreaterThan(0);
    expect(vec.every((v) => typeof v === "number")).toBe(true);
  });
});

describe("labelScenario", () => {
  it("returns a label string based on champion traits", () => {
    const label = labelScenario(["Leona", "LeeSin", "Aatrox"], TEST_CHAMPIONS);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("extractScenarios", () => {
  it("returns 1-5 scenarios from a tree", () => {
    const tree = makeTree();
    const scenarios = extractScenarios(tree, TEST_CHAMPIONS, 5);
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    expect(scenarios.length).toBeLessThanOrEqual(5);
  });

  it("each scenario has required fields", () => {
    const tree = makeTree();
    const scenarios = extractScenarios(tree, TEST_CHAMPIONS, 5);
    for (const s of scenarios) {
      expect(s.name).toBeDefined();
      expect(s.treePath).toBeDefined();
      expect(s.perspective).toBeDefined();
      expect(["robust", "likely", "off_profile"]).toContain(s.perspective);
    }
  });
});
