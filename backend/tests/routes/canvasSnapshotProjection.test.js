import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildCanvasSnapshot,
} = require("../../routes/canvasProjections");
const {
  Canvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
} = require("../../models/Canvas");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    toJSON: () => ({ id: "c1", name: "C", cardLayout: "wide" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
});

describe("buildCanvasSnapshot", () => {
  // The failure mode is SILENT client-side erasure: the canvasUpdate handler
  // reconciles whatever arrives, so a missing key wipes every annotation on
  // every remote client.
  it("always carries an annotations array, even when there are none", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload).toHaveProperty("annotations");
    expect(payload.annotations).toEqual([]);
  });

  it("returns annotations as plain JSON", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([
      { toJSON: () => ({ id: "a1", text: "why we lost" }) },
    ]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload.annotations).toEqual([{ id: "a1", text: "why we lost" }]);
  });

  it("scopes the annotation query to the canvas", async () => {
    const findAll = vi
      .spyOn(CanvasAnnotation, "findAll")
      .mockResolvedValue([]);
    await buildCanvasSnapshot("c1");
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { canvas_id: "c1" } }),
    );
  });
});

// Static guard: this is what stops a fourteenth hand-built payload appearing.
describe("no route hand-builds a canvasUpdate payload", () => {
  it("every emitToRoom('canvasUpdate') passes a variable, not an object literal", async () => {
    const { readFileSync } = await import("node:fs");
    // drafts.js is in this list because it hand-builds two payloads that no
    // design section names — including the canvas-draft CREATE path, the most
    // common canvas mutation. A guard that omits a producer certifies nothing.
    for (const file of [
      "../../routes/canvas.js",
      "../../routes/users.js",
      "../../routes/drafts.js",
    ]) {
      const source = readFileSync(require.resolve(file), "utf8");
      const literalEmits = source.match(
        /emitToRoom\([^,]+,\s*"canvasUpdate",\s*\{/g,
      );
      expect(literalEmits, `${file} hand-builds a canvasUpdate payload`).toBe(
        null,
      );
    }
  });
});
