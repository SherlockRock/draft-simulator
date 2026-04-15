import { describe, it, expect } from "vitest";
import { handleRequest, convertDraftState } from "../src/worker.js";
import { loadChampionMeta, loadMatchupData } from "../src/data-loader.js";
import type { EngineRequest, DraftStateInput } from "../src/types.js";

function makeRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  const meta = loadChampionMeta();
  const matchup = loadMatchupData();
  const pool = Object.keys(meta.champions).slice(0, 30);

  return {
    draftState: {
      format: "standard",
      bans: [],
      picks: [],
      currentPhase: "ban1",
      currentSlot: 0,
      currentSide: "blue",
    },
    searchPool: pool,
    opponentModel: {
      type: "meta",
      weights: Object.fromEntries(pool.map((id) => [id, 1 / pool.length])),
    },
    playerModel: {
      championTiers: { core: pool.slice(0, 10), playable: pool.slice(10, 20), emergency: [] },
      weights: {},
    },
    metaData: {
      winRates: {},
      synergies: matchup.synergyRules,
      counters: matchup.counters,
    },
    config: {
      branchWidth: 3,
      maxDepth: 2,
      latencyBudgetMs: 3000,
      forcedMoves: [],
    },
    ...overrides,
  };
}

describe("convertDraftState", () => {
  it("converts empty DraftStateInput to empty DraftState", () => {
    const input: DraftStateInput = {
      format: "standard",
      bans: [],
      picks: [],
      currentPhase: "ban1",
      currentSlot: 0,
      currentSide: "blue",
    };
    const state = convertDraftState(input);
    expect(state.turnIndex).toBe(0);
    expect(state.blueBans).toEqual([]);
    expect(state.redBans).toEqual([]);
    expect(state.bluePicks).toEqual([]);
    expect(state.redPicks).toEqual([]);
  });

  it("converts bans and picks correctly", () => {
    const input: DraftStateInput = {
      format: "standard",
      bans: [
        { championId: "Aatrox", side: "blue", slot: 0 },
        { championId: "Ahri", side: "red", slot: 0 },
      ],
      picks: [
        { championId: "Jinx", side: "blue", slot: 0 },
      ],
      currentPhase: "pick1",
      currentSlot: 1,
      currentSide: "red",
    };
    const state = convertDraftState(input);
    expect(state.blueBans).toEqual(["Aatrox"]);
    expect(state.redBans).toEqual(["Ahri"]);
    expect(state.bluePicks).toEqual(["Jinx"]);
    expect(state.turnIndex).toBe(3);
  });
});

describe("handleRequest (full pipeline)", () => {
  it("computes a tree from an empty draft state", () => {
    const request = makeRequest();
    const output = handleRequest(request);

    expect(output.tree).toBeDefined();
    expect(output.tree.children.length).toBeGreaterThan(0);
    expect(output.scenarios).toBeInstanceOf(Array);
    expect(output.meta.nodesEvaluated).toBeGreaterThan(0);
    expect(output.meta.computeTimeMs).toBeGreaterThan(0);
    expect(output.meta.depthReached).toBeGreaterThanOrEqual(1);
  });

  it("computes from a mid-draft state", () => {
    const meta = loadChampionMeta();
    const pool = Object.keys(meta.champions).slice(0, 30);

    const request = makeRequest({
      draftState: {
        format: "standard",
        bans: [
          { championId: pool[0], side: "blue", slot: 0 },
          { championId: pool[1], side: "red", slot: 0 },
          { championId: pool[2], side: "blue", slot: 1 },
          { championId: pool[3], side: "red", slot: 1 },
          { championId: pool[4], side: "blue", slot: 2 },
          { championId: pool[5], side: "red", slot: 2 },
        ],
        picks: [
          { championId: pool[6], side: "blue", slot: 0 },
        ],
        currentPhase: "pick1",
        currentSlot: 1,
        currentSide: "red",
      },
    });

    const output = handleRequest(request);
    expect(output.tree.children.length).toBeGreaterThan(0);
    expect(output.meta.depthReached).toBeGreaterThanOrEqual(1);
  });

  it("scenarios have labels and perspectives", () => {
    const request = makeRequest();
    const output = handleRequest(request);

    if (output.scenarios.length > 0) {
      for (const s of output.scenarios) {
        expect(s.name.length).toBeGreaterThan(0);
        expect(["robust", "likely", "off_profile"]).toContain(s.perspective);
        expect(s.treePath).toBeInstanceOf(Array);
      }
    }
  });
});
