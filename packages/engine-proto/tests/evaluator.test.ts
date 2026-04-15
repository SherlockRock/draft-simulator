import { describe, it, expect } from "vitest";
import { evaluate } from "../src/evaluator.js";
import { TEST_CHAMPIONS, makeChampion } from "./helpers.js";
import { createAssignmentCache } from "../src/role-solver.js";
import type { MetaData, PlayerModel, Side, Phase, ChampionMeta } from "../src/types.js";

const DEFAULT_META: MetaData = {
  winRates: {},
  synergies: [
    { tags: ["engage_initiator", "follow_up_cc"], bonus: 0.3, description: "" },
    { tags: ["adc", "peel_support"], bonus: 0.25, description: "" },
  ],
  counters: {},
};

const DEFAULT_PLAYER: PlayerModel = {
  championTiers: {
    core: ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"],
    playable: ["Akali"],
    emergency: [],
  },
  weights: {},
};

function makeEvalCtx(overrides: {
  bluePicks?: string[];
  redPicks?: string[];
  phase?: Phase;
  userSide?: Side;
  pool?: string[];
  champions?: Record<string, ChampionMeta>;
  playerModel?: PlayerModel;
}) {
  const cache = createAssignmentCache();
  return {
    bluePicks: overrides.bluePicks ?? [],
    redPicks: overrides.redPicks ?? [],
    blueBans: [] as string[],
    redBans: [] as string[],
    phase: overrides.phase ?? "pick1" as Phase,
    userSide: overrides.userSide ?? "blue" as Side,
    remainingPool: overrides.pool ?? Object.keys(TEST_CHAMPIONS),
    champions: overrides.champions ?? TEST_CHAMPIONS,
    metaData: DEFAULT_META,
    playerModel: overrides.playerModel ?? DEFAULT_PLAYER,
    assignmentCache: cache,
  };
}

describe("evaluate", () => {
  it("returns -Infinity composite when no valid role assignment exists", () => {
    const champs: Record<string, ChampionMeta> = {};
    for (const name of ["A", "B", "C", "D", "E"]) {
      champs[name] = makeChampion(name, ["ADC"]);
    }
    const ctx = makeEvalCtx({
      bluePicks: ["A", "B", "C", "D", "E"],
      champions: champs,
    });
    const scores = evaluate(ctx);
    expect(scores.composite).toBe(-Infinity);
  });

  it("returns finite composite for a valid 5-champion comp", () => {
    const ctx = makeEvalCtx({
      bluePicks: ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"],
    });
    const scores = evaluate(ctx);
    expect(scores.composite).toBeGreaterThan(-Infinity);
    expect(Number.isFinite(scores.composite)).toBe(true);
  });

  it("scores balanced damage higher than skewed damage", () => {
    const balanced = makeEvalCtx({
      bluePicks: ["Aatrox", "LeeSin", "Ahri", "Jinx", "Leona"],
    });
    const skewedChamps = { ...TEST_CHAMPIONS };
    skewedChamps["Riven"] = makeChampion("Riven", ["MIDDLE"], {
      damageProfile: { physical: 0.9, magic: 0.05, true: 0.05 },
    });
    const skewed = makeEvalCtx({
      bluePicks: ["Aatrox", "LeeSin", "Riven", "Jinx", "Leona"],
      champions: skewedChamps,
    });
    const balancedScores = evaluate(balanced);
    const skewedScores = evaluate(skewed);
    expect(balancedScores.compStrength).toBeGreaterThan(skewedScores.compStrength);
  });

  it("returns higher flex retention when adding a flex champion", () => {
    const singleRole = makeEvalCtx({ bluePicks: ["Jinx"] });
    const flexPick = makeEvalCtx({ bluePicks: ["Akali"] });
    const singleScores = evaluate(singleRole);
    const flexScores = evaluate(flexPick);
    expect(flexScores.flexRetention).toBeGreaterThanOrEqual(singleScores.flexRetention);
  });

  it("penalizes emergency-tier picks in player feasibility", () => {
    const player: PlayerModel = {
      championTiers: { core: ["LeeSin", "Ahri", "Jinx", "Leona"], playable: [], emergency: ["Aatrox"] },
      weights: {},
    };
    const emergencyCtx = makeEvalCtx({ bluePicks: ["Aatrox"], playerModel: player });
    const coreCtx = makeEvalCtx({ bluePicks: ["LeeSin"] });
    const emergencyScores = evaluate(emergencyCtx);
    const coreScores = evaluate(coreCtx);
    expect(emergencyScores.compStrength).toBeLessThan(coreScores.compStrength);
  });

  it("works for partial teams (1-4 champions)", () => {
    for (let n = 1; n <= 4; n++) {
      const picks = ["Aatrox", "LeeSin", "Ahri", "Jinx"].slice(0, n);
      const ctx = makeEvalCtx({ bluePicks: picks });
      const scores = evaluate(ctx);
      expect(Number.isFinite(scores.composite)).toBe(true);
    }
  });

  it("applies different weights per phase", () => {
    const picks = ["Aatrox", "LeeSin", "Ahri"];
    const earlyCtx = makeEvalCtx({ bluePicks: picks, phase: "pick1" });
    const lateCtx = makeEvalCtx({ bluePicks: picks, phase: "pick2" });
    const earlyScores = evaluate(earlyCtx);
    const lateScores = evaluate(lateCtx);
    expect(earlyScores.composite).not.toBe(lateScores.composite);
  });
});
