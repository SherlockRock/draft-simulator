import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { championAliasForKey } = require("../../../utils/championKeys");
const catalog = new Set(require("../../../../frontend/src/data/champions.json").champions.map((c) => c.id));
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const { resources } = JSON.parse(readFileSync(join(FIXTURES, "game-resources.json"), "utf8")).reply;

describe("esclub champion resources", () => {
  const characters = resources.filter((r) => r.type_resource === "Character" && r.name !== "Placeholder");
  it("has the expected champions and one Placeholder", () => {
    expect(characters.length).toBeGreaterThanOrEqual(170);
    expect(resources.filter((r) => r.name === "Placeholder")).toHaveLength(1);
  });
  it("every non-Placeholder Character maps to a catalog champion id", () => {
    const missing = characters.filter((r) => !catalog.has(championAliasForKey(r.id_external))).map((r) => `${r.name}:${r.id_external}`);
    expect(missing).toEqual([]);
  });
  it("the Placeholder maps to nothing", () => {
    expect(championAliasForKey("-1")).toBeNull();
  });
});
