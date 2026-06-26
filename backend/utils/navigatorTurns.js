// Single source of truth for the backend's 20-slot draft turn sequence.
// Mirrors competitive standard draft phasing: ban1 ×6 → pick1 ×6 → ban2 ×4 → pick2 ×4.
//
// The frontend has its own richer sequence at frontend/src/utils/turnSequence.ts
// with pairStart/pairEnd metadata for pair-pick UI handling. Do not try to share
// between FE/BE — that's a larger refactor with its own tradeoffs.

const TURN_SEQUENCE = [
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "red", type: "ban", phase: "ban2" },
  { side: "blue", type: "ban", phase: "ban2" },
  { side: "red", type: "ban", phase: "ban2" },
  { side: "blue", type: "ban", phase: "ban2" },
  { side: "red", type: "pick", phase: "pick2" },
  { side: "blue", type: "pick", phase: "pick2" },
  { side: "blue", type: "pick", phase: "pick2" },
  { side: "red", type: "pick", phase: "pick2" },
];

const TOTAL_TURNS = TURN_SEQUENCE.length;

function getTurn(slot) {
  if (typeof slot !== "number" || !Number.isInteger(slot)) return null;
  if (slot < 0 || slot >= TOTAL_TURNS) return null;
  return TURN_SEQUENCE[slot];
}

function currentTurn(eventCount) {
  return getTurn(eventCount);
}

module.exports = {
  TURN_SEQUENCE,
  TOTAL_TURNS,
  getTurn,
  currentTurn,
};
