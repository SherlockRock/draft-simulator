import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TEAM_REGIONS, isValidRegion } = require("../../utils/teamRegions");

describe("teamRegions", () => {
  it("holds the six supported regions", () => {
    expect([...TEAM_REGIONS]).toEqual([
      "na1", "euw1", "eun1", "kr", "br1", "oc1",
    ]);
  });

  it("accepts each region and nothing else", () => {
    for (const region of TEAM_REGIONS) {
      expect(isValidRegion(region), region).toBe(true);
    }
    expect(isValidRegion("xx9")).toBe(false);
    expect(isValidRegion("")).toBe(false);
    expect(isValidRegion(null)).toBe(false);
    expect(isValidRegion(undefined)).toBe(false);
    expect(isValidRegion(5)).toBe(false);
  });

  it("is the set routes/teams.js validates against", () => {
    const routes = require("../../routes/teams");
    expect(routes.isValidRegion).toBe(isValidRegion);
  });
});
