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

describe("engine-node boundary", () => {
  it("createEngine constructs from real JSON files", () => {
    expect(engine).toBeTruthy();
  });

  it("compute returns parsable response with tree + scenarios", async () => {
    const token = new CancelToken();
    const json = await engine.compute(makeRequest(), token);
    const r = JSON.parse(json);
    expect(r.protocolVersion).toBe("1.0.0");
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
});
