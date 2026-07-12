import { describe, expect, it } from "vitest";
import { resolveEnterAction, type EnterResolutionInput } from "./championPickerEnter";

const aatrox = { id: "266", name: "Aatrox" };
const ahri = { id: "103", name: "Ahri" };
const akali = { id: "84", name: "Akali" };
const all = [aatrox, ahri, akali];

const base = (overrides: Partial<EnterResolutionInput>): EnterResolutionInput => ({
    searchText: "",
    filteredItems: all,
    allChampions: all,
    armed: false,
    highlightedItem: aatrox,
    isAvailable: () => true,
    ...overrides
});

describe("resolveEnterAction", () => {
    it("skips on empty search when not armed (hover highlight does not arm)", () => {
        expect(resolveEnterAction(base({ searchText: "" }))).toEqual({ type: "skip" });
        expect(resolveEnterAction(base({ searchText: "   " }))).toEqual({ type: "skip" });
    });

    it("commits the exact name match when available", () => {
        expect(resolveEnterAction(base({ searchText: "  AHRI " }))).toEqual({
            type: "commit",
            champion: ahri
        });
    });

    it("skips when the exact match is unavailable (no fallback)", () => {
        const result = resolveEnterAction(
            base({ searchText: "ahri", isAvailable: (id) => id !== ahri.id })
        );
        expect(result).toEqual({ type: "skip" });
    });

    it("commits the first AVAILABLE filtered result when no exact match", () => {
        const result = resolveEnterAction(
            base({
                searchText: "a",
                filteredItems: [aatrox, ahri, akali],
                isAvailable: (id) => id !== aatrox.id
            })
        );
        expect(result).toEqual({ type: "commit", champion: ahri });
    });

    it("skips when text matches nothing or only unavailable champions", () => {
        expect(
            resolveEnterAction(base({ searchText: "zzz", filteredItems: [] }))
        ).toEqual({ type: "skip" });
        expect(
            resolveEnterAction(base({ searchText: "a", isAvailable: () => false }))
        ).toEqual({ type: "skip" });
    });

    it("commits the armed highlight over the search resolution", () => {
        const result = resolveEnterAction(
            base({ searchText: "ahri", armed: true, highlightedItem: akali })
        );
        expect(result).toEqual({ type: "commit", champion: akali });
    });

    it("falls back to search resolution when the armed highlight is unavailable", () => {
        const result = resolveEnterAction(
            base({
                searchText: "ahri",
                armed: true,
                highlightedItem: akali,
                isAvailable: (id) => id !== akali.id
            })
        );
        expect(result).toEqual({ type: "commit", champion: ahri });
    });

    it("commits the armed highlight even with empty search", () => {
        const result = resolveEnterAction(
            base({ searchText: "", armed: true, highlightedItem: akali })
        );
        expect(result).toEqual({ type: "commit", champion: akali });
    });
});
