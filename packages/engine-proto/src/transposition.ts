import type { DraftState } from "./types.js";

interface TranspositionEntry {
  depth: number;
  score: number;
  bestMove: string | null;
}

export function draftStateKey(state: DraftState): string {
  const bb = [...state.blueBans].sort().join(",");
  const rb = [...state.redBans].sort().join(",");
  const bp = state.bluePicks.join(",");
  const rp = state.redPicks.join(",");
  return `${state.turnIndex}|bb:${bb}|rb:${rb}|bp:${bp}|rp:${rp}`;
}

export class TranspositionTable {
  private table = new Map<string, TranspositionEntry>();
  hits = 0;

  store(state: DraftState, depth: number, score: number, bestMove: string | null): void {
    const key = draftStateKey(state);
    const existing = this.table.get(key);
    if (!existing || depth >= existing.depth) {
      this.table.set(key, { depth, score, bestMove });
    }
  }

  lookup(state: DraftState, minDepth: number): TranspositionEntry | null {
    const key = draftStateKey(state);
    const entry = this.table.get(key);
    if (!entry || entry.depth < minDepth) return null;
    this.hits++;
    return entry;
  }

  get size(): number {
    return this.table.size;
  }
}
