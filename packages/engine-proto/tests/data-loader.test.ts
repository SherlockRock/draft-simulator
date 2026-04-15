import { describe, it, expect } from "vitest";
import { loadChampionMeta, loadMatchupData } from "../src/data-loader.js";

describe("loadChampionMeta", () => {
  it("loads and returns typed champion metadata", () => {
    const meta = loadChampionMeta();
    expect(meta.version).toBeDefined();
    expect(meta.champions).toBeDefined();
    expect(meta.champions["Aatrox"]).toBeDefined();
    expect(meta.champions["Aatrox"].positions).toContain("TOP");
    expect(meta.champions["Aatrox"].damageProfile.physical).toBeGreaterThan(0);
  });

  it("has entries for all expected champions", () => {
    const meta = loadChampionMeta();
    const count = Object.keys(meta.champions).length;
    expect(count).toBeGreaterThanOrEqual(160);
  });
});

describe("loadMatchupData", () => {
  it("loads and returns typed matchup data", () => {
    const data = loadMatchupData();
    expect(data.compiledAt).toBeDefined();
    expect(data.synergyRules).toBeInstanceOf(Array);
    expect(data.synergyRules.length).toBeGreaterThan(0);
    expect(data.synergyRules[0].tags).toHaveLength(2);
    expect(data.synergyRules[0].bonus).toBeGreaterThan(0);
  });

  it("has counters as an object (empty is OK for MVP)", () => {
    const data = loadMatchupData();
    expect(typeof data.counters).toBe("object");
  });
});
