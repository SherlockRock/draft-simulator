import { describe, it, expect } from "vitest";
import { extractScenarios, collectLeaves, computeFeatureVector, labelScenario } from "../src/scenario.js";
import { TEST_CHAMPIONS } from "./helpers.js";
import type { TreeNode, ScoreSet } from "../src/types.js";

const ZERO_SCORES: ScoreSet = {
  composite: 0, compStrength: 0, informationValue: 0, flexRetention: 0, revealCost: 0,
};

function makeTree(): TreeNode {
  return {
    championIds: [],
    scores: ZERO_SCORES,
    assignmentDistribution: [],
    side: null,
    slots: [],
    actionType: "ban",
    phase: "ban1",
    userInjected: false,
    children: [
      {
        championIds: ["Aatrox"],
        scores: { ...ZERO_SCORES, composite: 0.8 },
        assignmentDistribution: [],
        side: "blue",
        slots: [0],
        actionType: "ban",
        phase: "ban1",
        userInjected: false,
        children: [
          {
            championIds: ["LeeSin"],
            scores: { ...ZERO_SCORES, composite: 0.7 },
            assignmentDistribution: [],
            side: "red",
            slots: [1],
            actionType: "ban",
            phase: "ban1",
            userInjected: false,
            children: [
              {
                championIds: ["Ahri"],
                scores: { ...ZERO_SCORES, composite: 0.6 },
                assignmentDistribution: [],
                side: "blue",
                slots: [6],
                actionType: "pick",
                phase: "pick1",
                userInjected: false,
                children: [],
              },
            ],
          },
        ],
      },
      {
        championIds: ["Jinx"],
        scores: { ...ZERO_SCORES, composite: 0.5 },
        assignmentDistribution: [],
        side: "blue",
        slots: [0],
        actionType: "ban",
        phase: "ban1",
        userInjected: false,
        children: [
          {
            championIds: ["Leona"],
            scores: { ...ZERO_SCORES, composite: 0.4 },
            assignmentDistribution: [],
            side: "red",
            slots: [1],
            actionType: "ban",
            phase: "ban1",
            userInjected: false,
            children: [],
          },
        ],
      },
    ],
  };
}

describe("collectLeaves", () => {
  it("collects all leaf nodes with tree paths", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    expect(leaves).toHaveLength(2);
    for (const leaf of leaves) {
      expect(leaf.path.length).toBeGreaterThan(0);
    }
  });

  it("accumulates blue bans from ban nodes on the blue side", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    const deepLeaf = leaves.find((leaf) => leaf.path.length === 3);
    expect(deepLeaf).toBeDefined();
    expect(deepLeaf!.blueBans).toEqual(["Aatrox"]);
  });

  it("accumulates red bans from ban nodes on the red side", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    const deepLeaf = leaves.find((leaf) => leaf.path.length === 3);
    expect(deepLeaf).toBeDefined();
    expect(deepLeaf!.redBans).toEqual(["LeeSin"]);
  });

  it("accumulates blue picks from pick nodes on the blue side", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    const deepLeaf = leaves.find((leaf) => leaf.path.length === 3);
    expect(deepLeaf).toBeDefined();
    expect(deepLeaf!.bluePicks).toEqual(["Ahri"]);
  });

  it("does not add picks to ban arrays or vice versa", () => {
    const tree = makeTree();
    const leaves = collectLeaves(tree);
    const shallowLeaf = leaves.find((leaf) => leaf.path.length === 2);
    expect(shallowLeaf).toBeDefined();
    expect(shallowLeaf!.blueBans).toEqual(["Jinx"]);
    expect(shallowLeaf!.redBans).toEqual(["Leona"]);
    expect(shallowLeaf!.bluePicks).toEqual([]);
    expect(shallowLeaf!.redPicks).toEqual([]);
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

  it("each scenario has required fields including ban arrays", () => {
    const tree = makeTree();
    const scenarios = extractScenarios(tree, TEST_CHAMPIONS, 5);
    for (const s of scenarios) {
      expect(s.name).toBeDefined();
      expect(s.treePath).toBeDefined();
      expect(s.perspective).toBeDefined();
      expect(["robust", "likely", "off_profile"]).toContain(s.perspective);
      expect(Array.isArray(s.blueBans)).toBe(true);
      expect(Array.isArray(s.redBans)).toBe(true);
    }
  });

  it("populates ban arrays from the leaf's path", () => {
    const tree = makeTree();
    const scenarios = extractScenarios(tree, TEST_CHAMPIONS, 5);
    const withBans = scenarios.find((s) => s.blueBans.length > 0 || s.redBans.length > 0);
    expect(withBans).toBeDefined();
  });
});
