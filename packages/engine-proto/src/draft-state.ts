import type { DraftState, TurnInfo } from "./types.js";

export const TURN_SEQUENCE: TurnInfo[] = [
  // Ban Phase 1 (turns 0-5)
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red",  type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red",  type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red",  type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  // Pick Phase 1 (turns 6-11): B1, R1-R2, B2-B3, R3
  { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
  { side: "red",  type: "pick", phase: "pick1", pairStart: true,  pairEnd: false },
  { side: "red",  type: "pick", phase: "pick1", pairStart: false, pairEnd: true  },
  { side: "blue", type: "pick", phase: "pick1", pairStart: true,  pairEnd: false },
  { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: true  },
  { side: "red",  type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
  // Ban Phase 2 (turns 12-15)
  { side: "red",  type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "red",  type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  // Pick Phase 2 (turns 16-19): R4, B4-B5, R5
  { side: "red",  type: "pick", phase: "pick2", pairStart: false, pairEnd: false },
  { side: "blue", type: "pick", phase: "pick2", pairStart: true,  pairEnd: false },
  { side: "blue", type: "pick", phase: "pick2", pairStart: false, pairEnd: true  },
  { side: "red",  type: "pick", phase: "pick2", pairStart: false, pairEnd: false },
];

export function createEmptyDraft(): DraftState {
  return {
    blueBans: [],
    redBans: [],
    bluePicks: [],
    redPicks: [],
    turnIndex: 0,
  };
}

export function getCurrentTurn(state: DraftState): TurnInfo | null {
  if (state.turnIndex >= TURN_SEQUENCE.length) return null;
  return TURN_SEQUENCE[state.turnIndex];
}

export function applyMove(state: DraftState, championId: string): DraftState {
  const turn = getCurrentTurn(state);
  if (!turn) throw new Error("Cannot apply move: draft is complete");

  const next: DraftState = {
    blueBans: [...state.blueBans],
    redBans: [...state.redBans],
    bluePicks: [...state.bluePicks],
    redPicks: [...state.redPicks],
    turnIndex: state.turnIndex + 1,
  };

  if (turn.type === "ban") {
    if (turn.side === "blue") next.blueBans.push(championId);
    else next.redBans.push(championId);
  } else {
    if (turn.side === "blue") next.bluePicks.push(championId);
    else next.redPicks.push(championId);
  }

  return next;
}

export function isTerminal(state: DraftState): boolean {
  return state.turnIndex >= TURN_SEQUENCE.length;
}

export function allTakenChampions(state: DraftState): Set<string> {
  return new Set([
    ...state.blueBans,
    ...state.redBans,
    ...state.bluePicks,
    ...state.redPicks,
  ]);
}

export function remainingPool(state: DraftState, pool: string[]): string[] {
  const taken = allTakenChampions(state);
  return pool.filter((c) => !taken.has(c));
}
