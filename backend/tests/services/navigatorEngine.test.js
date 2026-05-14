import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

// navigatorEngine.js is CommonJS — load it (and the model it requires) via
// Node's CommonJS resolver so we can patch the model's create() method
// directly on the same instance the service holds a reference to. This is
// simpler and more reliable than ESM-style vi.mock for CJS interop here.
const require = createRequire(import.meta.url);
const NavigatorSnapshot = require("../../models/NavigatorSnapshot");
const { shapeSnapshot, persistSnapshot } = require("../../services/navigatorEngine");

let createSpy;
beforeEach(() => {
  createSpy = vi.spyOn(NavigatorSnapshot, "create");
});

describe("shapeSnapshot", () => {
  it("returns wire shape without touching the DB", () => {
    const mockResponse = {
      tree: { championIds: [], children: [] },
      scenarios: [],
      meta: { nodesEvaluated: 5, computeTimeMs: 100 },
    };
    const shaped = shapeSnapshot({ id: "nd-1" }, "ev-1", mockResponse);
    expect(shaped.id).toBeNull();
    expect(shaped.navigator_draft_id).toBe("nd-1");
    expect(shaped.after_event_id).toBe("ev-1");
    expect(shaped.tree).toEqual(mockResponse.tree);
    expect(shaped.scenarios).toEqual(mockResponse.scenarios);
    expect(shaped.meta).toEqual(mockResponse.meta);
    expect(shaped.createdAt).toBeNull();
    expect(shaped.updatedAt).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("persistSnapshot", () => {
  it("writes the expected columns and merges row id/createdAt/updatedAt", async () => {
    createSpy.mockResolvedValue({
      id: "snap-1",
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
    });
    const shaped = {
      id: null,
      navigator_draft_id: "nd-1",
      after_event_id: "ev-1",
      tree: { championIds: [] },
      scenarios: [],
      meta: { nodesEvaluated: 5 },
      createdAt: null,
      updatedAt: null,
    };
    const result = await persistSnapshot(shaped);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({
      navigator_draft_id: "nd-1",
      after_event_id: "ev-1",
      pruned_tree: { championIds: [] },
      scenarios: [],
      compute_meta: { nodesEvaluated: 5 },
    });
    expect(result.id).toBe("snap-1");
    expect(result.createdAt).toBe("2026-05-13T00:00:00Z");
    expect(result.updatedAt).toBe("2026-05-13T00:00:00Z");
    // Original shaped fields are preserved.
    expect(result.navigator_draft_id).toBe("nd-1");
    expect(result.tree).toEqual({ championIds: [] });
  });
});
