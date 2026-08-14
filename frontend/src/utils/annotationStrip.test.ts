import { describe, it, expect } from "vitest";
import {
    isChampionAvailableForStrip,
    addToStrip,
    removeFromStrip
} from "./annotationStrip";

describe("isChampionAvailableForStrip", () => {
    // D18: a duplicate within ONE strip carries no meaning and is almost
    // certainly a misclick.
    it("refuses a champion already in this strip", () => {
        expect(isChampionAvailableForStrip(["Ahri", "Azir"])("Ahri")).toBe(false);
    });

    it("allows one that is not", () => {
        expect(isChampionAvailableForStrip(["Ahri"])("Orianna")).toBe(true);
    });

    // The same champion in DIFFERENT annotations is how it legitimately sits in
    // two tiers, so this predicate must know nothing about other strips.
    it("is scoped to the strip it was given", () => {
        expect(isChampionAvailableForStrip([])("Ahri")).toBe(true);
    });
});

describe("strip mutation", () => {
    // D3: append/remove only. No drag reorder, no move-left/right —
    // reordering means removing and re-adding.
    it("appends to the end", () => {
        expect(addToStrip(["Ahri"], "Azir")).toEqual(["Ahri", "Azir"]);
    });

    it("is a no-op for a champion already present", () => {
        expect(addToStrip(["Ahri"], "Ahri")).toEqual(["Ahri"]);
    });

    it("removes by id and preserves the rest in order", () => {
        expect(removeFromStrip(["Ahri", "Azir", "Orianna"], "Azir")).toEqual([
            "Ahri",
            "Orianna"
        ]);
    });

    it("returns a NEW array so the store write is a real change", () => {
        const before = ["Ahri"];
        expect(addToStrip(before, "Azir")).not.toBe(before);
    });
});
