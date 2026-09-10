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
    const shaped = shapeSnapshot("nd-1", "ev-1", mockResponse);
    expect(shaped.source).toBe("persisted");
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
    expect(result.source).toBe("persisted");
    expect(result.id).toBe("snap-1");
    expect(result.createdAt).toBe("2026-05-13T00:00:00Z");
    expect(result.updatedAt).toBe("2026-05-13T00:00:00Z");
    // Original shaped fields are preserved.
    expect(result.navigator_draft_id).toBe("nd-1");
    expect(result.tree).toEqual({ championIds: [] });
  });
});

const { resolveEngineOptions, FM_WEIGHTS_PATH } = require("../../services/navigatorEngine");

describe("resolveEngineOptions (NAVIGATOR_FM kill switch, design §4)", () => {
  it("passes the FM weights path by default", () => {
    const opts = resolveEngineOptions({});
    expect(opts.fmWeightsPath).toBe(FM_WEIGHTS_PATH);
    expect(FM_WEIGHTS_PATH.endsWith("data/compiled/fm-weights.json")).toBe(true);
    expect(opts.championMetaPath.endsWith("data/compiled/champion-meta.json")).toBe(true);
  });

  it("omits the path entirely when NAVIGATOR_FM=off", () => {
    const opts = resolveEngineOptions({ NAVIGATOR_FM: "off" });
    expect("fmWeightsPath" in opts).toBe(false);
  });

  it("treats any other value as on", () => {
    expect(resolveEngineOptions({ NAVIGATOR_FM: "" }).fmWeightsPath).toBe(FM_WEIGHTS_PATH);
    expect(resolveEngineOptions({ NAVIGATOR_FM: "OFF" }).fmWeightsPath).toBe(FM_WEIGHTS_PATH);
  });
});

describe("makeProgressForwarder", () => {
  const { makeProgressForwarder } = require("../../services/navigatorEngine");

  it("returns undefined when there is no consumer (no callback reaches the engine)", () => {
    expect(makeProgressForwarder(() => true, undefined)).toBeUndefined();
  });

  it("parses and forwards while the compute is current", () => {
    const seen = [];
    const fwd = makeProgressForwarder(() => true, (m) => seen.push(m));
    fwd(JSON.stringify({ kind: "heartbeat", depthInProgress: 2, nodes: 10, elapsedMs: 300 }));
    expect(seen).toEqual([{ kind: "heartbeat", depthInProgress: 2, nodes: 10, elapsedMs: 300 }]);
  });

  it("drops messages once the compute is superseded", () => {
    const seen = [];
    let current = true;
    const fwd = makeProgressForwarder(() => current, (m) => seen.push(m));
    fwd(JSON.stringify({ kind: "heartbeat", depthInProgress: 1, nodes: 1, elapsedMs: 1 }));
    current = false;
    fwd(JSON.stringify({ kind: "heartbeat", depthInProgress: 1, nodes: 2, elapsedMs: 2 }));
    expect(seen).toHaveLength(1);
  });

  it("swallows a throwing consumer and malformed JSON", () => {
    const fwd = makeProgressForwarder(() => true, () => {
      throw new Error("consumer broke");
    });
    expect(() => fwd(JSON.stringify({ kind: "heartbeat" }))).not.toThrow();
    expect(() => fwd("{not json")).not.toThrow();
  });

  it("drops a partial whose protocolVersion major mismatches, forwards a matching partial, and leaves heartbeats unaffected (final review #3)", () => {
    const seen = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fwd = makeProgressForwarder(() => true, (m) => seen.push(m));
    fwd(
      JSON.stringify({
        kind: "partial",
        response: { protocolVersion: "2.0.0", meta: { depthReached: 1 } },
      }),
    );
    fwd(
      JSON.stringify({
        kind: "partial",
        response: { protocolVersion: "1.2.0", meta: { depthReached: 1 } },
      }),
    );
    fwd(JSON.stringify({ kind: "heartbeat", depthInProgress: 1, nodes: 5, elapsedMs: 10 }));
    expect(seen).toHaveLength(2);
    expect(seen[0].response.protocolVersion).toBe("1.2.0");
    expect(seen[1].kind).toBe("heartbeat");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("computeForDraft streams progress from the real engine", () => {
  const { computeForDraft } = require("../../services/navigatorEngine");
  const fs = require("node:fs");
  const path = require("node:path");

  it("invokes options.onProgress with partials and heartbeats and persists exactly one final", async () => {
    createSpy.mockImplementation(async (row) => ({
      id: "snap-1",
      createdAt: new Date("2026-09-07T20:00:00Z"),
      updatedAt: new Date("2026-09-07T20:00:00Z"),
      ...row,
    }));
    // data/compiled/champion-meta.json = { version, patch, compiledAt, sources, champions: { [id]: { id, positions: ["TOP", ...], ... } } }
    const metaPath = path.resolve(__dirname, "../../../data/compiled/champion-meta.json");
    const champions = JSON.parse(fs.readFileSync(metaPath, "utf8")).champions;
    const ids = Object.keys(champions);
    const byRole = (role) => ids.filter((id) => (champions[id].positions || []).includes(role));
    // Session pools use the lowercase role keys (`TeamPool.display`), the engine request maps them.
    const display = {
      top: byRole("TOP"), jungle: byRole("JUNGLE"), mid: byRole("MIDDLE"),
      adc: byRole("BOTTOM"), support: byRole("SUPPORT"),
    };
    const pool = { display, search: ids };
    const session = {
      id: "sess-stream", our_side: "red", draft_mode: "standard", series_length: 1,
      side_swap_mode: "auto", config_version: 1, blue_pool: pool, red_pool: pool,
    };
    const draft = { id: "draft-stream", session_id: "sess-stream", game_number: 1, status: "active", our_side_override: null };
    const at = (i) => new Date(Date.UTC(2026, 8, 7, 20, 0, i)).toISOString();
    const bans = ["Aatrox", "Thresh", "Ivern", "Nidalee", "Zilean", "Blitzcrank"];
    const events = bans.map((champion_id, slot) => ({
      id: `ev-${slot}`, navigator_draft_id: draft.id, event_type: "ban", slot,
      side: slot % 2 === 0 ? "blue" : "red", champion_id, user_injected: false, createdAt: at(slot),
    }));
    events.push({
      id: "ev-6", navigator_draft_id: draft.id, event_type: "pick", slot: 6, side: "blue",
      champion_id: "Zyra", user_injected: false, createdAt: at(6),
    });

    const seen = [];
    const result = await computeForDraft(draft, session, events, 7, null, {
      onProgress: (m) => seen.push(m),
    });

    const partials = seen.filter((m) => m.kind === "partial");
    const heartbeats = seen.filter((m) => m.kind === "heartbeat");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0].response.meta.depthReached).toBe(1);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(result.snapshot.source).toBe("persisted");
    expect(result.snapshot.meta.inProgress).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
  }, 30000);
});
