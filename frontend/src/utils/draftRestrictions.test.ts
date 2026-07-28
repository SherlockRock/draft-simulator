import { describe, it, expect } from "vitest";
import { getRestrictedChampionsForGroup } from "./draftRestrictions";

const game = (id: string, seriesIndex: number, picks: string[]) => ({
    id,
    name: `Game ${seriesIndex + 1}`,
    picks: [
        // 0-9 bans
        ...Array<string>(10).fill(""),
        // 10-19 picks
        ...picks,
        ...Array<string>(10 - picks.length).fill("")
    ],
    seriesIndex
});

const seriesGroup = (mode: string) => ({
    type: "series",
    metadata: { seriesType: mode, draftMode: mode }
});

describe("getRestrictedChampionsForGroup", () => {
    // The bug this module exists to prevent: Canvas.tsx bailed out for any
    // group whose type wasn't "custom", so fearless series groups — which is
    // every series created on a canvas — greyed out nothing at all.
    it("restricts earlier games' picks in a fearless SERIES group", () => {
        const drafts = [game("g1", 0, ["Aatrox", "Ahri"]), game("g2", 1, [])];

        const restricted = getRestrictedChampionsForGroup({
            group: seriesGroup("fearless"),
            drafts,
            currentDraftId: "g2"
        });

        expect(restricted).toContain("Aatrox");
        expect(restricted).toContain("Ahri");
    });

    it("does not let a later game restrict an earlier one", () => {
        const drafts = [game("g1", 0, ["Aatrox"]), game("g2", 1, ["Zed"])];

        const restricted = getRestrictedChampionsForGroup({
            group: seriesGroup("fearless"),
            drafts,
            currentDraftId: "g1"
        });

        expect(restricted).not.toContain("Zed");
        expect(restricted).toEqual([]);
    });

    it("includes bans as well as picks for ironman series", () => {
        const withBans = {
            id: "g1",
            name: "Game 1",
            picks: [
                "Jax",
                ...Array<string>(9).fill(""),
                "Aatrox",
                ...Array<string>(9).fill("")
            ],
            seriesIndex: 0
        };

        const restricted = getRestrictedChampionsForGroup({
            group: seriesGroup("ironman"),
            drafts: [withBans, game("g2", 1, [])],
            currentDraftId: "g2"
        });

        expect(restricted).toContain("Jax");
        expect(restricted).toContain("Aatrox");
    });

    it("restricts symmetrically in a CUSTOM group, ignoring order", () => {
        const drafts = [game("d1", 0, ["Aatrox"]), game("d2", 0, ["Zed"])];
        const group = { type: "custom", metadata: { draftMode: "fearless" } };

        expect(
            getRestrictedChampionsForGroup({ group, drafts, currentDraftId: "d1" })
        ).toContain("Zed");
        expect(
            getRestrictedChampionsForGroup({ group, drafts, currentDraftId: "d2" })
        ).toContain("Aatrox");
    });

    it("returns nothing for standard mode", () => {
        const drafts = [game("g1", 0, ["Aatrox"]), game("g2", 1, [])];
        expect(
            getRestrictedChampionsForGroup({
                group: seriesGroup("standard"),
                drafts,
                currentDraftId: "g2"
            })
        ).toEqual([]);
    });

    // Series groups carry the mode in seriesType, but older/local rows may only
    // have draftMode. The backend gate falls back the same way
    // (canvasMutations.js), and the two must agree or the UI greys out
    // something the server would accept, or vice versa.
    it("falls back to draftMode when a series group has no seriesType", () => {
        const drafts = [game("g1", 0, ["Aatrox"]), game("g2", 1, [])];

        const restricted = getRestrictedChampionsForGroup({
            group: { type: "series", metadata: { draftMode: "fearless" } },
            drafts,
            currentDraftId: "g2"
        });

        expect(restricted).toContain("Aatrox");
    });

    it("returns nothing when the group has no mode at all", () => {
        const drafts = [game("g1", 0, ["Aatrox"]), game("g2", 1, [])];
        expect(
            getRestrictedChampionsForGroup({
                group: { type: "series", metadata: {} },
                drafts,
                currentDraftId: "g2"
            })
        ).toEqual([]);
    });
});
