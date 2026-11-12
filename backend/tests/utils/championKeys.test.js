import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { championAliasForKey, CHAMPION_KEY_COUNT } = require("../../utils/championKeys");
const { canonicalizeAlias } = require("../../utils/championAlias");
const catalog = require("../../../frontend/src/data/champions.json");

describe("canonicalizeAlias", () => {
  it("maps the known divergence and passes others through", () => {
    expect(canonicalizeAlias("FiddleSticks")).toBe("Fiddlesticks");
    expect(canonicalizeAlias("Jayce")).toBe("Jayce");
  });
});

describe("championAliasForKey", () => {
  it("accepts a string or a number key", () => {
    expect(championAliasForKey("126")).toBe("Jayce");
    expect(championAliasForKey(126)).toBe("Jayce");
  });

  it("canonicalises Fiddlesticks", () => {
    expect(championAliasForKey(9)).toBe("Fiddlesticks");
  });

  it("returns null for placeholder, non-numeric and unknown keys", () => {
    expect(championAliasForKey("-1")).toBeNull();
    expect(championAliasForKey("abc")).toBeNull();
    expect(championAliasForKey(999999)).toBeNull();
    expect(championAliasForKey(null)).toBeNull();
    expect(championAliasForKey(undefined)).toBeNull();
  });

  it("maps only catalog champions, not CDragon cosmetics", () => {
    expect(championAliasForKey(60001)).toBeNull(); // Jade_Annie in CDragon
    expect(CHAMPION_KEY_COUNT).toBe(catalog.champions.length);
  });

  it("covers every champion in the frontend catalog", () => {
    expect(CHAMPION_KEY_COUNT).toBeGreaterThan(0);
    const images = new Set();
    for (let k = 0; k < 2000; k++) {
      const a = championAliasForKey(k);
      if (a) images.add(a);
    }
    const missing = catalog.champions.map((c) => c.id).filter((id) => !images.has(id));
    expect(missing).toEqual([]);
  });
});
