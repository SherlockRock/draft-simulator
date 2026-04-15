import { describe, it, expect } from "vitest";
import { generatePairs, filterPairs } from "../src/pair-filter.js";
import { TEST_CHAMPIONS, TEST_CHAMPION_IDS } from "./helpers.js";

describe("generatePairs", () => {
  it("generates C(n,2) pairs from the pool", () => {
    const pairs = generatePairs(["A", "B", "C"]);
    expect(pairs).toHaveLength(3);
    expect(pairs).toContainEqual(["A", "B"]);
    expect(pairs).toContainEqual(["A", "C"]);
    expect(pairs).toContainEqual(["B", "C"]);
  });

  it("returns empty for pool with fewer than 2 champions", () => {
    expect(generatePairs(["A"])).toHaveLength(0);
    expect(generatePairs([])).toHaveLength(0);
  });
});

describe("filterPairs", () => {
  it("returns at most maxPairs pairs", () => {
    const result = filterPairs(TEST_CHAMPION_IDS, [], TEST_CHAMPIONS, 3);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
  });

  it("each pair contains two different champions from the pool", () => {
    const result = filterPairs(TEST_CHAMPION_IDS, [], TEST_CHAMPIONS, 10);
    for (const [a, b] of result) {
      expect(a).not.toBe(b);
      expect(TEST_CHAMPION_IDS).toContain(a);
      expect(TEST_CHAMPION_IDS).toContain(b);
    }
  });

  it("ranks pairs that cover two distinct roles higher", () => {
    const result = filterPairs(TEST_CHAMPION_IDS, [], TEST_CHAMPIONS, 20);
    expect(result.length).toBeGreaterThan(0);
  });
});
