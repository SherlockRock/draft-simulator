import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Pool = require("../../models/Pool");
const SavedPool = require("../../models/SavedPool");

describe("Pool model (design §1.1)", () => {
  it("holds only the payload: id, name, champions", () => {
    const attrs = Pool.getAttributes();
    for (const column of ["id", "name", "champions"]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
    // No owner, no canvas — a pool row is inert until a parent claims it (D1).
    expect(attrs.owner_id).toBeUndefined();
    expect(attrs.canvas_id).toBeUndefined();
  });

  it("defaults champions to the empty five-role map", () => {
    expect(Pool.getAttributes().champions.defaultValue).toEqual({
      top: [], jungle: [], mid: [], adc: [], support: [],
    });
  });

  it("carries the champions-revision counter, defaulted to 0", () => {
    expect(Pool.getAttributes().version.defaultValue).toBe(0);
    expect(Pool.getAttributes().version.allowNull).toBe(false);
  });
});

describe("SavedPool model (design §1.2 remodel)", () => {
  it("is a pure parent link: owner_id + pool_id, payload columns gone", () => {
    const attrs = SavedPool.getAttributes();
    expect(attrs.owner_id).toBeDefined();
    expect(attrs.pool_id).toBeDefined();
    expect(attrs.pool_id.allowNull).toBe(false);
    // The no-aliasing invariant at the DB (D1).
    expect(attrs.pool_id.unique).toBeTruthy();
    expect(attrs.name).toBeUndefined();
    expect(attrs.champions).toBeUndefined();
  });
});
