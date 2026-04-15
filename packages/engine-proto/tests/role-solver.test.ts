import { describe, it, expect } from "vitest";
import { solveAssignments, createAssignmentCache } from "../src/role-solver.js";
import { TEST_CHAMPIONS, makeChampion } from "./helpers.js";

describe("solveAssignments", () => {
  it("finds the obvious assignment for 5 single-role champions", () => {
    const champs = ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"];
    const result = solveAssignments(champs, TEST_CHAMPIONS);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const best = result[0];
    expect(best.assignment.TOP).toBe("Aatrox");
    expect(best.assignment.JUNGLE).toBe("LeeSin");
    expect(best.assignment.MIDDLE).toBe("Ahri");
    expect(best.assignment.ADC).toBe("Jinx");
    expect(best.assignment.SUPPORT).toBe("Leona");
  });

  it("finds multiple assignments when a champion has flex positions", () => {
    const champs = ["Akali", "LeeSin", "Ahri", "Jinx", "Leona"];
    const result = solveAssignments(champs, TEST_CHAMPIONS);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const roles = result.map((r) => r.assignment.TOP);
    expect(roles).toContain("Akali");
  });

  it("returns lower weight when forced off-role", () => {
    const champs2 = { ...TEST_CHAMPIONS };
    champs2["Sivir"] = makeChampion("Sivir", ["ADC"]);
    const result = solveAssignments(["Jinx", "Sivir", "Aatrox", "LeeSin", "Leona"], champs2);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].weight).toBeLessThan(1);
  });

  it("handles partial teams (fewer than 5 champions)", () => {
    const result = solveAssignments(["Aatrox", "Ahri"], TEST_CHAMPIONS);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].assignment.TOP).toBe("Aatrox");
    expect(result[0].assignment.MIDDLE).toBe("Ahri");
  });

  it("handles single champion", () => {
    const result = solveAssignments(["Aatrox"], TEST_CHAMPIONS);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].assignment.TOP).toBe("Aatrox");
  });

  it("returns empty for empty input", () => {
    const result = solveAssignments([], TEST_CHAMPIONS);
    expect(result).toEqual([]);
  });
});

describe("createAssignmentCache", () => {
  it("returns same result for same champion set", () => {
    const cache = createAssignmentCache();
    const result1 = cache.solve(["Aatrox", "Ahri"], TEST_CHAMPIONS);
    const result2 = cache.solve(["Aatrox", "Ahri"], TEST_CHAMPIONS);
    expect(result1).toBe(result2);
  });

  it("returns same result regardless of input order", () => {
    const cache = createAssignmentCache();
    const result1 = cache.solve(["Aatrox", "Ahri"], TEST_CHAMPIONS);
    const result2 = cache.solve(["Ahri", "Aatrox"], TEST_CHAMPIONS);
    expect(result1).toBe(result2);
  });
});
