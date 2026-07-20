import { describe, expect, it } from "vitest";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import {
    classifySlot,
    computeSearchResults,
    isDraftInProgress,
    type SearchQuery
} from "./canvasSearch";

const identity = (value: string) => value;

const championOnly = (championId: string): SearchQuery => ({
    championId,
    teamName: null,
    bucket: null
});

const emptyPicks = (): string[] => Array.from({ length: 20 }, () => "");

/** All 20 slots filled with unique filler; overrides set specific indices. */
const fullPicks = (overrides: Record<number, string> = {}): string[] => {
    const picks = Array.from({ length: 20 }, (_, i) => `Filler${i}`);
    for (const [index, value] of Object.entries(overrides)) {
        picks[Number(index)] = value;
    }
    return picks;
};

type InnerDraft = CanvasDraft["Draft"];

const makeDraft = (
    id: string,
    picks: string[],
    extra: Partial<Omit<InnerDraft, "picks">> & { group_id?: string | null } = {}
): CanvasDraft => {
    const { group_id, ...inner } = extra;
    return {
        positionX: 0,
        positionY: 0,
        group_id: group_id ?? null,
        Draft: { id, name: id, type: "canvas", picks, ...inner }
    };
};

const makeGroup = (id: string, metadata: CanvasGroup["metadata"] = {}): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: "series",
    positionX: 0,
    positionY: 0,
    metadata
});

describe("classifySlot", () => {
    it("classifies the four index ranges", () => {
        expect(classifySlot(0)).toEqual({ phase: "ban", side: "blue" });
        expect(classifySlot(4)).toEqual({ phase: "ban", side: "blue" });
        expect(classifySlot(5)).toEqual({ phase: "ban", side: "red" });
        expect(classifySlot(9)).toEqual({ phase: "ban", side: "red" });
        expect(classifySlot(10)).toEqual({ phase: "pick", side: "blue" });
        expect(classifySlot(14)).toEqual({ phase: "pick", side: "blue" });
        expect(classifySlot(15)).toEqual({ phase: "pick", side: "red" });
        expect(classifySlot(19)).toEqual({ phase: "pick", side: "red" });
    });
});

describe("isDraftInProgress", () => {
    it("uses completed flag when present (versus-imported drafts)", () => {
        expect(
            isDraftInProgress(makeDraft("a", emptyPicks(), { completed: false }))
        ).toBe(true);
        expect(isDraftInProgress(makeDraft("b", emptyPicks(), { completed: true }))).toBe(
            false
        );
    });

    it("falls back to empty pick slots for manual drafts", () => {
        expect(isDraftInProgress(makeDraft("a", fullPicks()))).toBe(false);
        expect(isDraftInProgress(makeDraft("b", fullPicks({ 12: "" })))).toBe(true);
        // Empty BAN slots alone do not mean in progress
        expect(isDraftInProgress(makeDraft("c", fullPicks({ 0: "", 7: "" })))).toBe(
            false
        );
    });
});

describe("computeSearchResults — champion-only", () => {
    it("matches picks and bans with slot classification", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 2: "Jinx", 16: "Jinx" })),
            makeDraft("d2", fullPicks({ 11: "Jinx" })),
            makeDraft("d3", fullPicks())
        ];
        const results = computeSearchResults(drafts, [], championOnly("Jinx"), identity);

        expect(results.buckets).toBeNull();
        expect(results.matches.map((m) => m.draftId)).toEqual(["d1", "d2"]);
        expect(results.matches[0].slots).toEqual([
            { index: 2, phase: "ban", side: "blue", bucket: null },
            { index: 16, phase: "pick", side: "red", bucket: null }
        ]);
        expect(results.matches[1].slots).toEqual([
            { index: 11, phase: "pick", side: "blue", bucket: null }
        ]);
    });

    it("resolves legacy pick values through the injected resolver", () => {
        const legacyResolver = (value: string) => (value === "222" ? "Jinx" : value);
        const drafts = [makeDraft("d1", fullPicks({ 13: "222" }))];
        const results = computeSearchResults(
            drafts,
            [],
            championOnly("Jinx"),
            legacyResolver
        );
        expect(results.matches).toHaveLength(1);
        expect(results.matches[0].slots[0].index).toBe(13);
    });

    it("never matches empty slots even if the resolver would map them", () => {
        const sloppyResolver = () => "Jinx";
        const drafts = [makeDraft("d1", emptyPicks())];
        const results = computeSearchResults(
            drafts,
            [],
            championOnly("Jinx"),
            sloppyResolver
        );
        expect(results.matches).toHaveLength(0);
    });

    it("flags in-progress matches and carries groupId", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 10: "Jinx", 14: "" }), { group_id: "g1" })
        ];
        const results = computeSearchResults(
            drafts,
            [makeGroup("g1")],
            championOnly("Jinx"),
            identity
        );
        expect(results.matches[0].inProgress).toBe(true);
        expect(results.matches[0].groupId).toBe("g1");
        expect(results.matches[0].outcome).toBeNull();
    });
});
