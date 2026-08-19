import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CanvasPoolPlacement } = require("../../models/Canvas");

describe("CanvasPoolPlacement model (design §1.3)", () => {
  it("is defined with the columns the design's data model names", () => {
    const attrs = CanvasPoolPlacement.getAttributes();
    for (const column of [
      "id",
      "canvas_id",
      "pool_id",
      "positionX",
      "positionY",
      "source_id",
    ]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
  });

  it("requires pool_id and enforces the no-aliasing UNIQUE invariant", () => {
    const attrs = CanvasPoolPlacement.getAttributes();
    expect(attrs.pool_id.allowNull).toBe(false);
    expect(attrs.pool_id.unique).toBeTruthy();
  });

  it("defaults positionX/positionY to 50 (free-floating v1, D6)", () => {
    const attrs = CanvasPoolPlacement.getAttributes();
    expect(attrs.positionX.defaultValue).toBe(50);
    expect(attrs.positionY.defaultValue).toBe(50);
  });

  // Deliberate divergences from CanvasAnnotations (design §1.3): no resize
  // writer exists for a pool card (height is a pure function of contents), and
  // group membership is a deferred slice that would put a field on the wire
  // nothing can set yet. Both would be silent no-ops if added prematurely.
  it("has no width/height/group_id columns (deliberate divergences, design §1.3)", () => {
    const attrs = CanvasPoolPlacement.getAttributes();
    expect(attrs.width).toBeUndefined();
    expect(attrs.height).toBeUndefined();
    expect(attrs.group_id).toBeUndefined();
  });
});
