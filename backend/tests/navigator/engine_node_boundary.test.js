import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Bypass Vite/vitest source-transform for the native .node binary by loading
// through Node's CommonJS require.
const require = createRequire(import.meta.url);
const { Engine, CancelToken } = require("@draft-sim/engine-node");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CHAMP_META = path.join(REPO_ROOT, "data/compiled/champion-meta.json");
const MATCHUP = path.join(REPO_ROOT, "data/compiled/matchup-data.json");

let engine;
beforeAll(() => {
  engine = Engine.create({
    championMetaPath: CHAMP_META,
    matchupDataPath: MATCHUP,
  });
});

function decodeError(err) {
  try {
    return JSON.parse(err.message);
  } catch {
    return { code: "unknown", message: err.message };
  }
}

function makeRequest(overrides = {}) {
  const base = {
    protocolVersion: "1.0.0",
    draftState: {
      format: "standard",
      bans: [],
      picks: [],
      currentPhase: "ban1",
      currentSlot: 0,
      currentSide: "blue",
    },
    pools: {
      ourSide: "blue",
      blue: {
        display: {
          TOP: ["Aatrox"],
          JUNGLE: ["LeeSin"],
          MIDDLE: ["Ahri"],
          ADC: ["Jinx"],
          SUPPORT: ["Leona"],
        },
        search: ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"],
      },
      red: {
        display: {
          TOP: ["Aatrox"],
          JUNGLE: ["LeeSin"],
          MIDDLE: ["Ahri"],
          ADC: ["Jinx"],
          SUPPORT: ["Leona"],
        },
        search: ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"],
      },
      crossGameExclusions: [],
    },
    opponentModel: { type: "meta", weights: {} },
    playerModel: {
      championTiers: { core: [], playable: [], emergency: [] },
      weights: {},
    },
    config: {
      search: {
        branchWidth: 2,
        pairBranchWidth: 4,
        singlePairTopK: 4,
        maxDepth: 1,
        broadDepth: 1,
        extensionTurnThreshold: 8,
        latencyBudgetMs: 2000,
      },
      weights: {
        phaseWeights: {
          blue: {
            ban1: { comp: 0.5, info: 0.5, coverage: 0.0 },
            pick1: { comp: 0.5, info: 0.5, coverage: 0.0 },
            ban2: { comp: 0.5, info: 0.5, coverage: 0.0 },
            pick2: { comp: 0.5, info: 0.5, coverage: 0.0 },
          },
          red: {
            ban1: { comp: 0.5, info: 0.5, coverage: 0.0 },
            pick1: { comp: 0.5, info: 0.5, coverage: 0.0 },
            ban2: { comp: 0.5, info: 0.5, coverage: 0.0 },
            pick2: { comp: 0.5, info: 0.5, coverage: 0.0 },
          },
        },
        penalties: { outOfRole: 0.25, outOfPool: 0.75 },
        synergyMultiplier: 1.0,
        counterMultiplier: 1.0,
        flexRetentionWeight: 1.0,
        revealCostWeight: 1.0,
      },
      profile: "firstpick-default-v1",
      forcedBranches: [],
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

// Slot 7 (Red 1+2 pair start) after six bans and Blue's Zyra, with
// singlePairTopK: 2 and maxDepth: 2. Exactly two root pairs carry the Blue
// 2+3 pair below them; the others are leaf pair children with the same wire
// shape (two championIds, no children). This is the wire the frontend's
// ranked fan reads.
function slot7PairRootRequest() {
  const pool = ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona", "Zyra", "Garen", "Ezreal"];
  const display = { TOP: [], JUNGLE: [], MIDDLE: [], ADC: [], SUPPORT: [] };
  const req = JSON.parse(makeRequest());
  req.draftState = {
    format: "standard",
    bans: ["Annie", "Brand", "Corki", "Darius", "Ekko", "Fizz"].map((championId, slot) => ({
      championId,
      side: slot % 2 === 0 ? "blue" : "red",
      slot,
    })),
    picks: [{ championId: "Zyra", side: "blue", slot: 6 }],
    currentPhase: "pick1",
    currentSlot: 7,
    currentSide: "red",
  };
  req.pools.blue = { display, search: pool };
  req.pools.red = { display, search: pool };
  req.config.search = {
    ...req.config.search,
    pairBranchWidth: 500,
    singlePairTopK: 2,
    maxDepth: 2,
    latencyBudgetMs: 10000,
  };
  return req;
}

describe("engine-node boundary", () => {
  it("createEngine constructs from real JSON files", () => {
    expect(engine).toBeTruthy();
  });

  it("compute returns parsable response with tree + scenarios", async () => {
    const token = new CancelToken();
    const json = await engine.compute(makeRequest(), token);
    const r = JSON.parse(json);
    expect(r.protocolVersion).toBe("1.2.0");
    expect(r.engineId).toBe("firstpick/v1.0.0");
    expect(r.tree).toBeDefined();
    expect(Array.isArray(r.scenarios)).toBe(true);
    expect(r.meta).toMatchObject({ cancelled: false });
    expect(typeof r.meta.computeTimeMs).toBe("number");
    expect(typeof r.meta.depthReached).toBe("number");
  });

  it("cancelled token causes compute to reject with engine.cancelled", async () => {
    const token = new CancelToken();
    token.cancel();
    let caught;
    try {
      await engine.compute(makeRequest(), token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(decodeError(caught).code).toBe("engine.cancelled");
  });

  it("invalid forced branch (reverse-fill pair force) rejects with engine.invalid_input + path", async () => {
    const req = JSON.parse(makeRequest());
    req.config.forcedBranches = [
      {
        path: [{ slot: 9, championIds: ["Aatrox"] }],
        targetSlot: 7,
        championId: "Annie",
        mode: "sole",
      },
    ];
    const token = new CancelToken();
    let caught;
    try {
      await engine.compute(JSON.stringify(req), token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const decoded = decodeError(caught);
    expect(decoded.code).toBe("engine.invalid_input");
    expect(decoded.path).toEqual(["forcedBranches", "0"]);
  });

  it("singlePairTopK bounds the pairs searched while the root fan still lists every pair", async () => {
    const req = slot7PairRootRequest();
    const token = new CancelToken();
    const r = JSON.parse(await engine.compute(JSON.stringify(req), token));

    const children = r.tree.children;
    expect(children.length).toBeGreaterThan(2);
    for (const child of children) {
      expect(child.championIds).toHaveLength(2);
      expect(child.slots).toEqual([7, 8]);
    }
    const searched = children.filter((c) => c.children.length > 0);
    expect(searched).toHaveLength(2);
    expect(searched.every((c) => c.children[0].slots[0] === 9)).toBe(true);
    expect(children.slice(0, 2).every((c) => c.children.length > 0)).toBe(true);
    expect(r.meta.depthReached).toBe(2);
    expect(r.meta.cancelled).toBe(false);
  });

  it("streams one partial per completed depth, ascending, then resolves the final with inProgress false", async () => {
    const req = slot7PairRootRequest();
    req.config.search.maxDepth = 3;
    const messages = [];
    const r = JSON.parse(
      await engine.compute(JSON.stringify(req), new CancelToken(), (raw) => {
        messages.push(JSON.parse(raw));
      }),
    );
    const partials = messages.filter((m) => m.kind === "partial").map((m) => m.response);
    expect(partials.map((p) => p.meta.depthReached)).toEqual([1, 2]);
    expect(partials.map((p) => p.meta.depthInProgress)).toEqual([2, 3]);
    expect(partials.every((p) => p.meta.inProgress === true)).toBe(true);
    expect(partials.every((p) => p.meta.budgetHit === false)).toBe(true);
    expect(partials.every((p) => p.protocolVersion === "1.2.0")).toBe(true);
    expect(partials.every((p) => Array.isArray(p.tree.children) && p.tree.children.length > 0)).toBe(true);
    expect(r.meta.inProgress).toBe(false);
    expect(r.meta.depthInProgress).toBe(0);
    expect(r.meta.depthReached).toBe(3);
  });

  it(
    "emits heartbeats every ~250 ms while a budget-bound compute runs",
    async () => {
      const req = slot7PairRootRequest();
      const pool = [
        "Aatrox", "LeeSin", "Ahri", "Jinx", "Leona", "Zyra", "Garen", "Ezreal", "Yasuo", "Thresh",
        "Vayne", "Malphite", "Orianna", "Kaisa", "Nautilus", "Camille", "Viktor", "Jhin", "Braum", "Lux",
      ];
      const display = { TOP: [], JUNGLE: [], MIDDLE: [], ADC: [], SUPPORT: [] };
      req.pools.blue = { display, search: pool };
      req.pools.red = { display, search: pool };
      req.config.search = { ...req.config.search, singlePairTopK: 30, maxDepth: 8, latencyBudgetMs: 1000 };

      const heartbeats = [];
      const r = JSON.parse(
        await engine.compute(JSON.stringify(req), new CancelToken(), (raw) => {
          const m = JSON.parse(raw);
          if (m.kind === "heartbeat") heartbeats.push(m);
        }),
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < heartbeats.length; i++) {
        expect(heartbeats[i].nodes).toBeGreaterThanOrEqual(heartbeats[i - 1].nodes);
        expect(heartbeats[i].elapsedMs).toBeGreaterThanOrEqual(heartbeats[i - 1].elapsedMs);
      }
      expect(heartbeats[heartbeats.length - 1].depthInProgress).toBeGreaterThanOrEqual(1);
      expect(r.meta.budgetHit).toBe(true);
      expect(r.meta.inProgress).toBe(false);
      expect(r.meta.cancelled).toBe(false);
      expect(r.meta.depthReached).toBeGreaterThanOrEqual(1);
    },
    10000,
  );

  it("compute without a callback still resolves and carries the new meta fields", async () => {
    const r = JSON.parse(await engine.compute(makeRequest(), new CancelToken()));
    expect(r.meta.inProgress).toBe(false);
    expect(typeof r.meta.depthInProgress).toBe("number");
    expect(typeof r.meta.budgetHit).toBe("boolean");
  });
});
