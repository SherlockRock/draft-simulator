import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TURN_SEQUENCE,
  TOTAL_TURNS,
  getTurn,
  currentTurn,
} = require("../../utils/navigatorTurns");

describe("TURN_SEQUENCE", () => {
  it("has exactly 20 turns", () => {
    expect(TURN_SEQUENCE.length).toBe(20);
    expect(TOTAL_TURNS).toBe(20);
  });

  it("starts with six ban1 entries alternating blue/red", () => {
    expect(TURN_SEQUENCE[0]).toEqual({ side: "blue", type: "ban", phase: "ban1" });
    expect(TURN_SEQUENCE[5]).toEqual({ side: "red", type: "ban", phase: "ban1" });
  });

  it("has pick1 phase from slot 6 to 11", () => {
    expect(TURN_SEQUENCE[6].phase).toBe("pick1");
    expect(TURN_SEQUENCE[11].phase).toBe("pick1");
  });

  it("has ban2 phase from slot 12 to 15", () => {
    expect(TURN_SEQUENCE[12].phase).toBe("ban2");
    expect(TURN_SEQUENCE[15].phase).toBe("ban2");
  });

  it("ends with pick2 phase on slot 19 (red)", () => {
    expect(TURN_SEQUENCE[19]).toEqual({ side: "red", type: "pick", phase: "pick2" });
  });
});

describe("getTurn(slot)", () => {
  it("returns the turn at the given slot", () => {
    expect(getTurn(0)).toEqual({ side: "blue", type: "ban", phase: "ban1" });
    expect(getTurn(6)).toEqual({ side: "blue", type: "pick", phase: "pick1" });
    expect(getTurn(19)).toEqual({ side: "red", type: "pick", phase: "pick2" });
  });

  it("returns null for out-of-range slots", () => {
    expect(getTurn(-1)).toBeNull();
    expect(getTurn(20)).toBeNull();
    expect(getTurn(100)).toBeNull();
  });

  it("returns null for non-numeric slots", () => {
    expect(getTurn(undefined)).toBeNull();
    expect(getTurn(null)).toBeNull();
    expect(getTurn("5")).toBeNull();
  });
});

describe("currentTurn(eventCount)", () => {
  it("returns the turn for the next slot given completed event count", () => {
    expect(currentTurn(0)).toEqual({ side: "blue", type: "ban", phase: "ban1" });
    expect(currentTurn(6)).toEqual({ side: "blue", type: "pick", phase: "pick1" });
    expect(currentTurn(19)).toEqual({ side: "red", type: "pick", phase: "pick2" });
  });

  it("returns null once the draft is complete", () => {
    expect(currentTurn(20)).toBeNull();
    expect(currentTurn(21)).toBeNull();
  });
});
