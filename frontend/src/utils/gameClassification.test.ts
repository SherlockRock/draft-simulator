import { describe, expect, it } from "vitest";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import {
    SCOPE_VALUES,
    effectiveGameType,
    gameTypeHint,
    matchesScope,
    resolvesTeamNames
} from "./gameClassification";

/** Mirrors the fixture style in canvasSearch.test.ts. */
const makeGroup = (
    id: string,
    metadata: CanvasGroup["metadata"] = {},
    type: CanvasGroup["type"] = "series"
): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type,
    positionX: 0,
    positionY: 0,
    metadata
});

const makeDraft = (id: string, group_id: string | null = null): CanvasDraft => ({
    positionX: 0,
    positionY: 0,
    group_id,
    Draft: { id, name: id, type: "canvas", picks: [] }
});

describe("effectiveGameType", () => {
    it("returns undefined with no group", () => {
        expect(effectiveGameType(undefined, undefined)).toBeUndefined();
    });

    it("falls back to scrim for an untagged series group (D6 structural fallback)", () => {
        expect(effectiveGameType(undefined, makeGroup("g", {}, "series"))).toBe("scrim");
    });

    it("stays undefined for an untagged custom group", () => {
        expect(
            effectiveGameType(undefined, makeGroup("g", {}, "custom"))
        ).toBeUndefined();
    });

    it("returns the stored value on a tagged series group", () => {
        expect(
            effectiveGameType(
                undefined,
                makeGroup("g", { gameType: "official" }, "series")
            )
        ).toBe("official");
    });

    it("lets an explicit scratch beat the structural fallback", () => {
        expect(
            effectiveGameType(
                undefined,
                makeGroup("g", { gameType: "scratch" }, "series")
            )
        ).toBe("scratch");
    });

    it("returns the stored value on a tagged custom group", () => {
        expect(
            effectiveGameType(undefined, makeGroup("g", { gameType: "scrim" }, "custom"))
        ).toBe("scrim");
    });

    it("keys the fallback on type === 'series' exactly, never 'not custom'", () => {
        // CanvasGroup.type is a two-value enum in both the DB (models/Canvas.js)
        // and the schema, so this guards the invariant rather than a current bug:
        // if a third type is ever added it must NOT inherit the series fallback.
        const custom = makeGroup("g", {}, "custom");
        expect(effectiveGameType(undefined, custom)).toBeUndefined();
        expect(matchesScope(effectiveGameType(undefined, custom), "all")).toBe(false);
    });
});

describe("the counted rule, now expressed as scope 'all'", () => {
    const counted = (group: CanvasGroup | undefined) =>
        matchesScope(effectiveGameType(undefined, group), "all");

    it("counts scrim and official, not scratch or untagged", () => {
        expect(counted(makeGroup("a", { gameType: "scrim" }, "custom"))).toBe(true);
        expect(counted(makeGroup("b", { gameType: "official" }, "custom"))).toBe(true);
        expect(counted(makeGroup("c", { gameType: "scratch" }, "series"))).toBe(false);
        expect(counted(undefined)).toBe(false);
    });

    it("is asymmetric on untagged: a series counts, a custom group does not", () => {
        // Deliberate (D6). A series group asserts by its structure that it holds
        // real games; a custom group asserts nothing. Do not "fix" this.
        expect(counted(makeGroup("s", {}, "series"))).toBe(true);
        expect(counted(makeGroup("c", {}, "custom"))).toBe(false);
    });

    it("is card-aware through effectiveGameType, the single source of truth", () => {
        // D4's invariant survives the removal of the isCounted* predicates: the
        // scope filter and the name resolver both go through effectiveGameType,
        // so they cannot disagree about a draft once the override column lands.
        const group = makeGroup("g", { gameType: "scratch" }, "series");
        const card = makeDraft("d", "g");
        expect(matchesScope(effectiveGameType(card, group), "all")).toBe(false);
        expect(matchesScope(effectiveGameType(card, group), "scratch")).toBe(true);
    });
});

describe("resolvesTeamNames", () => {
    it("resolves for anything classified, including scratch", () => {
        // Scratch MUST resolve, or a scratch-scoped search finds nothing: the
        // team would never match a side and would never reach the scope filter.
        expect(resolvesTeamNames(makeGroup("a", { gameType: "scratch" }, "series"))).toBe(
            true
        );
        expect(resolvesTeamNames(makeGroup("b", { gameType: "scratch" }, "custom"))).toBe(
            true
        );
        expect(resolvesTeamNames(makeGroup("c", { gameType: "scrim" }, "custom"))).toBe(
            true
        );
    });

    it("resolves for an untagged series via the structural fallback", () => {
        expect(resolvesTeamNames(makeGroup("s", {}, "series"))).toBe(true);
    });

    it("refuses only the untagged custom group", () => {
        // The one case that must stay closed — otherwise every scratch-work group
        // fills the team dropdown and attaches drafts to real teams.
        expect(resolvesTeamNames(makeGroup("c", {}, "custom"))).toBe(false);
        expect(resolvesTeamNames(undefined)).toBe(false);
    });
});

describe("matchesScope", () => {
    it("exposes the four scope values", () => {
        expect(SCOPE_VALUES).toEqual(["all", "official", "scrim", "scratch"]);
    });

    it("'all' means all COUNTED — it still rejects scratch and untagged", () => {
        // "all" is not "everything": scratch is deliberately excluded, which is
        // what keeps the default scope behaviour-preserving. Scratch is reachable
        // only by asking for it explicitly.
        expect(matchesScope("scrim", "all")).toBe(true);
        expect(matchesScope("official", "all")).toBe(true);
        expect(matchesScope("scratch", "all")).toBe(false);
        expect(matchesScope(undefined, "all")).toBe(false);
    });

    it("every named scope accepts only itself", () => {
        expect(matchesScope("official", "official")).toBe(true);
        expect(matchesScope("scrim", "official")).toBe(false);
        expect(matchesScope("scratch", "official")).toBe(false);
        expect(matchesScope(undefined, "official")).toBe(false);
        expect(matchesScope("scrim", "scrim")).toBe(true);
        expect(matchesScope("official", "scrim")).toBe(false);
        expect(matchesScope("scratch", "scrim")).toBe(false);
        expect(matchesScope(undefined, "scrim")).toBe(false);
        expect(matchesScope("scratch", "scratch")).toBe(true);
        expect(matchesScope("scrim", "scratch")).toBe(false);
        expect(matchesScope("official", "scratch")).toBe(false);
        expect(matchesScope(undefined, "scratch")).toBe(false);
    });

    it("never matches an untagged custom group under any scope", () => {
        // undefined is the one effective value with no scope that accepts it —
        // there is no way to ask for "groups nobody has classified".
        for (const scope of SCOPE_VALUES) {
            expect(matchesScope(undefined, scope)).toBe(false);
        }
    });
});

describe("gameTypeHint", () => {
    it("distinguishes untagged on a series from untagged on a custom group", () => {
        // The whole reason the hint exists. If someone collapses these two
        // branches, the dropdown goes back to offering Untagged and Scratch as
        // apparently-interchangeable options on a series group, where they are
        // NOT interchangeable — untagged counts as a scrim, scratch does not.
        const series = gameTypeHint(null, true);
        const custom = gameTypeHint(null, false);
        expect(series).not.toBe(custom);
        expect(series).toMatch(/scrim/i);
        expect(custom).toMatch(/not counted/i);
    });

    it("says counted for the two counted values and excluded for scratch", () => {
        expect(gameTypeHint("scrim", true)).toMatch(/counts/i);
        expect(gameTypeHint("official", true)).toMatch(/counts/i);
        expect(gameTypeHint("scratch", true)).toMatch(/excluded/i);
        // Scratch means the same thing on both group types, unlike untagged.
        expect(gameTypeHint("scratch", true)).toBe(gameTypeHint("scratch", false));
    });
});

describe("the wiring the two review rounds converged on", () => {
    it("accepts an untagged series group under scope 'all'", () => {
        // This only passes when matchesScope reads the EFFECTIVE type. Feeding it
        // the raw stored field would exclude exactly the population D6's fallback
        // exists to protect (local canvases, and every row the migration has not
        // reached), making scope "all" not behaviour-preserving.
        const group = makeGroup("g", {}, "series");
        expect(matchesScope(effectiveGameType(undefined, group), "all")).toBe(true);
    });

    it("treats an untagged series as scrim under a scrim scope", () => {
        const group = makeGroup("g", {}, "series");
        expect(matchesScope(effectiveGameType(undefined, group), "scrim")).toBe(true);
        expect(matchesScope(effectiveGameType(undefined, group), "official")).toBe(false);
    });
});
