import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Pool = require("../../models/Pool");
const SavedPool = require("../../models/SavedPool");
const { CanvasPoolPlacement } = require("../../models/Canvas");
const {
  destroyPoolsForCanvas,
  destroyPoolsForSavedEntries,
} = require("../../services/poolCleanup");

beforeEach(() => {
  vi.restoreAllMocks();
});

// The Pool row is the unit of deletion (design §1.4): FKs cascade pool ->
// parent, never parent -> pool, so a bulk parent delete must destroy the
// claimed Pool rows FIRST or they orphan.
describe("destroyPoolsForCanvas", () => {
  it("destroys exactly the claimed pool ids inside the passed transaction", async () => {
    const transaction = { id: "t1" };
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([
      { pool_id: "p1" },
      { pool_id: "p2" },
    ]);
    const poolDestroy = vi.spyOn(Pool, "destroy").mockResolvedValue(2);

    await destroyPoolsForCanvas("c-1", transaction);

    expect(CanvasPoolPlacement.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canvas_id: "c-1" },
        transaction,
      }),
    );
    expect(poolDestroy).toHaveBeenCalledWith({
      where: { id: ["p1", "p2"] },
      transaction,
    });
  });

  it("no-ops when the canvas has no placements", async () => {
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
    const poolDestroy = vi.spyOn(Pool, "destroy").mockResolvedValue(0);

    await destroyPoolsForCanvas("c-empty", undefined);

    expect(poolDestroy).not.toHaveBeenCalled();
  });
});

describe("destroyPoolsForSavedEntries", () => {
  it("destroys exactly the claimed pool ids inside the passed transaction", async () => {
    const transaction = { id: "t1" };
    vi.spyOn(SavedPool, "findAll").mockResolvedValue([
      { pool_id: "p3" },
      { pool_id: "p4" },
    ]);
    const poolDestroy = vi.spyOn(Pool, "destroy").mockResolvedValue(2);

    await destroyPoolsForSavedEntries("u-1", transaction);

    expect(SavedPool.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { owner_id: "u-1" },
        transaction,
      }),
    );
    expect(poolDestroy).toHaveBeenCalledWith({
      where: { id: ["p3", "p4"] },
      transaction,
    });
  });

  it("no-ops when the user has no saved pools", async () => {
    vi.spyOn(SavedPool, "findAll").mockResolvedValue([]);
    const poolDestroy = vi.spyOn(Pool, "destroy").mockResolvedValue(0);

    await destroyPoolsForSavedEntries("u-empty", undefined);

    expect(poolDestroy).not.toHaveBeenCalled();
  });
});
