import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CanvasAnnotation } = require("../../models/Canvas");

describe("CanvasAnnotation model", () => {
  it("is defined with the columns the design's data model names", () => {
    const attrs = CanvasAnnotation.getAttributes();
    for (const column of [
      "id",
      "canvas_id",
      "group_id",
      "positionX",
      "positionY",
      "width",
      "height",
      "text",
      "championIds",
      "color",
      "fontSize",
      "manualWidth",
      "manualHeight",
      "source_id",
    ]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
  });

  // `none` is a palette entry meaning transparent + borderless (D6), not the
  // absence of a colour — so it must be in the enum, not modelled as null.
  it("carries `none` as a colour value", () => {
    expect(CanvasAnnotation.getAttributes().color.values).toContain("none");
  });

  it("defaults text to empty and championIds to an empty array", () => {
    const attrs = CanvasAnnotation.getAttributes();
    expect(attrs.text.defaultValue).toBe("");
    expect(attrs.championIds.defaultValue).toEqual([]);
  });

  it("allows a null group_id — a note loose on the canvas", () => {
    expect(CanvasAnnotation.getAttributes().group_id.allowNull).toBe(true);
  });

  // D7's floor must be SEPARATE from the rendered height. Auto-fit writes
  // `height`; if the floor were read from `height` it would ratchet, and a note
  // grown by typing could never shrink back.
  it("keeps the manual floor nullable and distinct from height", () => {
    const attrs = CanvasAnnotation.getAttributes();
    expect(attrs.manualWidth.allowNull).toBe(true);
    expect(attrs.manualHeight.allowNull).toBe(true);
    expect(attrs.manualHeight.field).not.toBe(attrs.height.field);
  });
});
