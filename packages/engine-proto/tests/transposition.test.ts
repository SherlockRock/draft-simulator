import { describe, it, expect } from "vitest";
import { TranspositionTable, draftStateKey } from "../src/transposition.js";
import { createEmptyDraft, applyMove } from "../src/draft-state.js";

describe("draftStateKey", () => {
  it("produces identical keys for same state", () => {
    const state = createEmptyDraft();
    const s1 = applyMove(applyMove(state, "A"), "B");
    const s2 = applyMove(applyMove(state, "A"), "B");
    expect(draftStateKey(s1)).toBe(draftStateKey(s2));
  });

  it("produces different keys for different ban assignments", () => {
    const state = createEmptyDraft();
    const s1 = applyMove(applyMove(state, "A"), "B");
    const s2 = applyMove(applyMove(state, "B"), "A");
    expect(draftStateKey(s1)).not.toBe(draftStateKey(s2));
  });

  it("sorts bans within same side for order independence", () => {
    let s1 = createEmptyDraft();
    s1 = applyMove(s1, "A");
    s1 = applyMove(s1, "X");
    s1 = applyMove(s1, "C");

    let s2 = createEmptyDraft();
    s2 = applyMove(s2, "C");
    s2 = applyMove(s2, "X");
    s2 = applyMove(s2, "A");

    expect(draftStateKey(s1)).toBe(draftStateKey(s2));
  });
});

describe("TranspositionTable", () => {
  it("stores and retrieves entries", () => {
    const table = new TranspositionTable();
    const state = createEmptyDraft();
    table.store(state, 3, 0.75, "Aatrox");
    const entry = table.lookup(state, 3);
    expect(entry).not.toBeNull();
    expect(entry!.score).toBe(0.75);
    expect(entry!.bestMove).toBe("Aatrox");
  });

  it("returns null for missing entries", () => {
    const table = new TranspositionTable();
    expect(table.lookup(createEmptyDraft(), 1)).toBeNull();
  });

  it("returns null when stored depth is less than requested", () => {
    const table = new TranspositionTable();
    const state = createEmptyDraft();
    table.store(state, 2, 0.5, "Ahri");
    expect(table.lookup(state, 3)).toBeNull();
    expect(table.lookup(state, 2)).not.toBeNull();
    expect(table.lookup(state, 1)).not.toBeNull();
  });

  it("tracks hit count", () => {
    const table = new TranspositionTable();
    const state = createEmptyDraft();
    table.store(state, 2, 0.5, "Ahri");
    table.lookup(state, 1);
    table.lookup(state, 5);
    expect(table.hits).toBe(1);
  });
});
