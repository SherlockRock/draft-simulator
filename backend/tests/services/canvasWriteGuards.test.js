import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CanvasGroup } = require("../../models/Canvas");
const {
  findGroupNotOnCanvas,
} = require("../../services/canvasWriteGuards");

beforeEach(() => vi.restoreAllMocks());

describe("findGroupNotOnCanvas", () => {
  it("returns null and costs no query for an empty set", async () => {
    const findAll = vi.spyOn(CanvasGroup, "findAll");
    expect(await findGroupNotOnCanvas({ canvasId: "c1", groupIds: [] })).toBe(
      null,
    );
    expect(findAll).not.toHaveBeenCalled();
  });

  it("ignores nulls and undefined — an explicit ungroup is not a foreign id", async () => {
    const findAll = vi.spyOn(CanvasGroup, "findAll");
    expect(
      await findGroupNotOnCanvas({
        canvasId: "c1",
        groupIds: [null, undefined],
      }),
    ).toBe(null);
    expect(findAll).not.toHaveBeenCalled();
  });

  it("returns the first id that is not on the canvas", async () => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([{ id: "g1" }]);
    expect(
      await findGroupNotOnCanvas({ canvasId: "c1", groupIds: ["g1", "gX"] }),
    ).toBe("gX");
  });

  it("uses a caller-supplied `known` set instead of querying", async () => {
    const findAll = vi.spyOn(CanvasGroup, "findAll");
    expect(
      await findGroupNotOnCanvas({
        canvasId: "c1",
        groupIds: ["g1"],
        known: new Set(["g1"]),
      }),
    ).toBe(null);
    expect(findAll).not.toHaveBeenCalled();
  });
});
