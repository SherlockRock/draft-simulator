import { describe, it, expect } from "vitest";
import {
  TURN_SEQUENCE,
  createEmptyDraft,
  applyMove,
  getCurrentTurn,
  isTerminal,
  allTakenChampions,
  remainingPool,
} from "../src/draft-state.js";

describe("TURN_SEQUENCE", () => {
  it("has exactly 20 turns", () => {
    expect(TURN_SEQUENCE).toHaveLength(20);
  });

  it("ban phase 1 is 6 alternating blue/red bans", () => {
    const ban1 = TURN_SEQUENCE.slice(0, 6);
    expect(ban1.every((t) => t.type === "ban" && t.phase === "ban1")).toBe(true);
    expect(ban1.map((t) => t.side)).toEqual(["blue", "red", "blue", "red", "blue", "red"]);
  });

  it("pick phase 1 follows B1, R1-R2, B2-B3, R3 pattern", () => {
    const pick1 = TURN_SEQUENCE.slice(6, 12);
    expect(pick1.every((t) => t.type === "pick" && t.phase === "pick1")).toBe(true);
    expect(pick1.map((t) => t.side)).toEqual(["blue", "red", "red", "blue", "blue", "red"]);
  });

  it("marks correct pair starts and ends", () => {
    expect(TURN_SEQUENCE[7].pairStart).toBe(true);
    expect(TURN_SEQUENCE[8].pairEnd).toBe(true);
    expect(TURN_SEQUENCE[9].pairStart).toBe(true);
    expect(TURN_SEQUENCE[10].pairEnd).toBe(true);
    expect(TURN_SEQUENCE[17].pairStart).toBe(true);
    expect(TURN_SEQUENCE[18].pairEnd).toBe(true);
    expect(TURN_SEQUENCE[6].pairStart).toBe(false);
    expect(TURN_SEQUENCE[6].pairEnd).toBe(false);
  });
});

describe("createEmptyDraft", () => {
  it("starts at turn 0 with empty arrays", () => {
    const state = createEmptyDraft();
    expect(state.turnIndex).toBe(0);
    expect(state.blueBans).toEqual([]);
    expect(state.redBans).toEqual([]);
    expect(state.bluePicks).toEqual([]);
    expect(state.redPicks).toEqual([]);
  });
});

describe("getCurrentTurn", () => {
  it("returns turn info for the current turnIndex", () => {
    const state = createEmptyDraft();
    const turn = getCurrentTurn(state);
    expect(turn!.side).toBe("blue");
    expect(turn!.type).toBe("ban");
    expect(turn!.phase).toBe("ban1");
  });

  it("returns null for a completed draft", () => {
    const state = { ...createEmptyDraft(), turnIndex: 20 };
    expect(getCurrentTurn(state)).toBeNull();
  });
});

describe("applyMove", () => {
  it("adds blue ban to blueBans and advances turnIndex", () => {
    const state = createEmptyDraft();
    const next = applyMove(state, "Aatrox");
    expect(next.blueBans).toEqual(["Aatrox"]);
    expect(next.turnIndex).toBe(1);
    expect(state.blueBans).toEqual([]);
    expect(state.turnIndex).toBe(0);
  });

  it("adds red ban at turn 1", () => {
    let state = createEmptyDraft();
    state = applyMove(state, "Aatrox");
    state = applyMove(state, "Ahri");
    expect(state.redBans).toEqual(["Ahri"]);
    expect(state.turnIndex).toBe(2);
  });

  it("adds blue pick at turn 6", () => {
    let state = { ...createEmptyDraft(), turnIndex: 6, blueBans: ["a", "b", "c"], redBans: ["d", "e", "f"] };
    state = applyMove(state, "Jinx");
    expect(state.bluePicks).toEqual(["Jinx"]);
    expect(state.turnIndex).toBe(7);
  });

  it("does not mutate the input state", () => {
    const state = createEmptyDraft();
    const next = applyMove(state, "Aatrox");
    expect(state).not.toBe(next);
    expect(state.blueBans).not.toBe(next.blueBans);
  });
});

describe("isTerminal", () => {
  it("returns false for empty draft", () => {
    expect(isTerminal(createEmptyDraft())).toBe(false);
  });

  it("returns true at turnIndex 20", () => {
    expect(isTerminal({ ...createEmptyDraft(), turnIndex: 20 })).toBe(true);
  });
});

describe("allTakenChampions", () => {
  it("returns a set of all picked and banned champions", () => {
    const state = {
      blueBans: ["A"], redBans: ["B"],
      bluePicks: ["C"], redPicks: ["D"],
      turnIndex: 8,
    };
    const taken = allTakenChampions(state);
    expect(taken).toEqual(new Set(["A", "B", "C", "D"]));
  });
});

describe("remainingPool", () => {
  it("removes taken champions from the pool", () => {
    const state = { blueBans: ["A"], redBans: [], bluePicks: [], redPicks: [], turnIndex: 1 };
    const pool = ["A", "B", "C"];
    expect(remainingPool(state, pool)).toEqual(["B", "C"]);
  });
});
