import { describe, expect, it } from "vitest";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import {
    bucketFor,
    classifySlot,
    computeSearchResults,
    getTeamNameOptions,
    isDraftInProgress,
    resolveGroupTeamNames,
    teamSideInDraft,
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

const makeGroup = (
    id: string,
    metadata: CanvasGroup["metadata"] = {},
    teams: { Team1?: CanvasGroup["Team1"]; Team2?: CanvasGroup["Team2"] } = {}
): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: "series",
    positionX: 0,
    positionY: 0,
    metadata,
    ...(teams.Team1 !== undefined ? { Team1: teams.Team1 } : {}),
    ...(teams.Team2 !== undefined ? { Team2: teams.Team2 } : {})
});

const makeTeam = (id: string, name: string): CanvasGroup["Team1"] => ({
    id,
    owner_id: "owner-1",
    name
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

describe("teamSideInDraft", () => {
    const group = makeGroup("g1", { blueTeamName: "T1", redTeamName: "GenG" });

    it("maps team1/team2 through blueSideTeam (default team1 = blue)", () => {
        const game1 = makeDraft("d1", fullPicks(), { group_id: "g1" });
        expect(teamSideInDraft(game1, group, "T1")).toBe("blue");
        expect(teamSideInDraft(game1, group, "GenG")).toBe("red");

        const game2 = makeDraft("d2", fullPicks(), { group_id: "g1", blueSideTeam: 2 });
        expect(teamSideInDraft(game2, group, "T1")).toBe("red");
        expect(teamSideInDraft(game2, group, "GenG")).toBe("blue");
    });

    it("matches case-insensitively with trimming", () => {
        const game = makeDraft("d1", fullPicks(), { group_id: "g1" });
        expect(teamSideInDraft(game, group, "t1")).toBe("blue");
        expect(teamSideInDraft(game, group, "  geng  ")).toBe("red");
    });

    it("returns null for missing group or unknown team", () => {
        const game = makeDraft("d1", fullPicks());
        expect(teamSideInDraft(game, undefined, "T1")).toBeNull();
        expect(teamSideInDraft(game, group, "DRX")).toBeNull();
        expect(teamSideInDraft(game, makeGroup("g2"), "T1")).toBeNull();
    });
});

describe("bucketFor", () => {
    it("classifies all four combinations", () => {
        expect(bucketFor({ phase: "pick", side: "blue" }, "blue")).toBe("pickedBy");
        expect(bucketFor({ phase: "pick", side: "red" }, "blue")).toBe("pickedAgainst");
        expect(bucketFor({ phase: "ban", side: "blue" }, "blue")).toBe("bannedBy");
        expect(bucketFor({ phase: "ban", side: "red" }, "blue")).toBe("bannedAgainst");
    });
});

describe("getTeamNameOptions", () => {
    it("dedupes case-insensitively, keeps first casing, sorts, skips blanks", () => {
        const groups = [
            makeGroup("g1", { blueTeamName: "T1", redTeamName: "GenG" }),
            makeGroup("g2", { blueTeamName: "geng", redTeamName: "  " }),
            makeGroup("g3", {})
        ];
        expect(getTeamNameOptions(groups)).toEqual(["GenG", "T1"]);
    });
});

describe("resolveGroupTeamNames", () => {
    it("prefers the linked entity name over the metadata string", () => {
        const group = makeGroup(
            "g1",
            { blueTeamName: "Old T1", redTeamName: "Old T2" },
            { Team1: makeTeam("t1", "T1 Esports"), Team2: null }
        );
        expect(resolveGroupTeamNames(group)).toEqual({
            team1: "T1 Esports",
            team2: "Old T2"
        });
    });

    it("falls back to metadata strings when unlinked", () => {
        const group = makeGroup("g1", { blueTeamName: "Gen.G", redTeamName: "DK" });
        expect(resolveGroupTeamNames(group)).toEqual({ team1: "Gen.G", team2: "DK" });
    });

    it("returns null for missing names on both sides", () => {
        expect(resolveGroupTeamNames(makeGroup("g1"))).toEqual({
            team1: null,
            team2: null
        });
    });
});

describe("getTeamNameOptions — entity-backed", () => {
    it("surfaces the linked entity name instead of the stale metadata string", () => {
        const groups = [
            makeGroup(
                "g1",
                { blueTeamName: "Old Name", redTeamName: "DK" },
                { Team1: makeTeam("t1", "T1 Esports") }
            )
        ];
        expect(getTeamNameOptions(groups)).toEqual(["DK", "T1 Esports"]);
    });
});

describe("teamSideInDraft — entity-backed", () => {
    it("resolves a filter on the linked entity name to the correct side", () => {
        const group = makeGroup(
            "g1",
            { blueTeamName: "Old Name", redTeamName: "GenG" },
            { Team1: makeTeam("t1", "T1 Esports") }
        );
        const game = makeDraft("d1", fullPicks(), { group_id: "g1" });
        expect(teamSideInDraft(game, group, "T1 Esports")).toBe("blue");
        // the stale metadata name no longer matches once linked
        expect(teamSideInDraft(game, group, "Old Name")).toBeNull();
    });
});

describe("computeSearchResults — team-only (champion optional)", () => {
    const groups = [
        makeGroup(
            "g1",
            { blueTeamName: "T1", redTeamName: "GenG" },
            { Team1: makeTeam("t1", "T1 Esports") }
        )
    ];
    const teamOnly = (teamName: string): SearchQuery => ({
        championId: null,
        teamName,
        bucket: null
    });

    it("matches one card-level DraftMatch per draft the team is in", () => {
        const drafts = [
            makeDraft("d1", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            }),
            makeDraft("d2", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "red"
            }),
            // team not in this ungrouped draft → excluded
            makeDraft("d3", fullPicks())
        ];
        const results = computeSearchResults(
            drafts,
            groups,
            teamOnly("T1 Esports"),
            identity
        );

        expect(results.buckets).toBeNull();
        expect(results.matches.map((m) => m.draftId)).toEqual(["d1", "d2"]);
        // card-level: no per-slot highlights
        expect(results.matches[0].slots).toEqual([]);
        expect(results.matches[1].slots).toEqual([]);
        expect(results.matches[0].groupId).toBe("g1");
    });

    it("resolves the team via the string fallback when unlinked", () => {
        const stringGroups = [
            makeGroup("g1", { blueTeamName: "T1", redTeamName: "GenG" })
        ];
        const drafts = [
            makeDraft("d1", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            })
        ];
        const results = computeSearchResults(
            drafts,
            stringGroups,
            teamOnly("geng"),
            identity
        );
        expect(results.matches.map((m) => m.draftId)).toEqual(["d1"]);
    });

    it("excludes drafts whose group does not contain the team", () => {
        const drafts = [
            makeDraft("d1", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            })
        ];
        const results = computeSearchResults(drafts, groups, teamOnly("DRX"), identity);
        expect(results.matches).toEqual([]);
        expect(results.teamRecord).toEqual({
            games: 0,
            wins: 0,
            losses: 0,
            noResult: 0,
            inProgress: 0
        });
    });

    it("computes the team's W/L record with side-swap and winner mapping", () => {
        const drafts = [
            // T1 on blue, blue wins → win
            makeDraft("d1", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            }),
            // T1 on blue, red wins → loss
            makeDraft("d2", fullPicks(), {
                group_id: "g1",
                completed: true,
                winner: "red"
            }),
            // side-swap: T1 on red (blueSideTeam 2), red wins → win
            makeDraft("d3", fullPicks(), {
                group_id: "g1",
                blueSideTeam: 2,
                completed: true,
                winner: "red"
            }),
            // completed, no winner → no result
            makeDraft("d4", fullPicks(), { group_id: "g1", completed: true }),
            // in progress
            makeDraft("d5", fullPicks({ 14: "" }), { group_id: "g1", completed: false })
        ];
        const results = computeSearchResults(
            drafts,
            groups,
            teamOnly("T1 Esports"),
            identity
        );

        expect(results.buckets).toBeNull();
        expect(results.teamRecord).toEqual({
            games: 5,
            wins: 2,
            losses: 1,
            noResult: 1,
            inProgress: 1
        });
        expect(results.matches[3].outcome).toBe("noResult");
        expect(results.matches[4].inProgress).toBe(true);
        expect(results.matches[4].outcome).toBeNull();
    });

    it("leaves teamRecord null for champion-only and champion+team queries", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            })
        ];
        const championOnlyResults = computeSearchResults(
            drafts,
            groups,
            championOnly("Jinx"),
            identity
        );
        expect(championOnlyResults.teamRecord).toBeNull();

        const championPlusTeam = computeSearchResults(
            drafts,
            groups,
            { championId: "Jinx", teamName: "T1 Esports", bucket: null },
            identity
        );
        expect(championPlusTeam.teamRecord).toBeNull();
        expect(championPlusTeam.buckets).not.toBeNull();
    });
});

describe("computeSearchResults — team filter", () => {
    const groups = [makeGroup("g1", { blueTeamName: "T1", redTeamName: "GenG" })];
    const query = (bucket: SearchQuery["bucket"] = null): SearchQuery => ({
        championId: "Jinx",
        teamName: "T1",
        bucket
    });

    it("drops ungrouped drafts and buckets slots relative to the team", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            }),
            makeDraft("d2", fullPicks({ 3: "Jinx" }), {
                group_id: "g1",
                blueSideTeam: 2,
                completed: true,
                winner: "blue"
            }),
            makeDraft("d3", fullPicks({ 10: "Jinx" }))
        ];
        const results = computeSearchResults(drafts, groups, query(), identity);

        expect(results.matches.map((m) => m.draftId)).toEqual(["d1", "d2"]);
        expect(results.matches[0].slots[0].bucket).toBe("pickedBy");
        expect(results.matches[0].outcome).toBe("win");
        expect(results.matches[1].slots[0].bucket).toBe("bannedAgainst");
        expect(results.matches[1].outcome).toBe("loss");
    });

    it("aggregates bucket summaries with W/L, no-result, and in-progress", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            }),
            makeDraft("d2", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "red"
            }),
            makeDraft("d3", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true
            }),
            makeDraft("d4", fullPicks({ 12: "Jinx", 14: "" }), {
                group_id: "g1",
                completed: false
            }),
            makeDraft("d5", fullPicks({ 17: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            })
        ];
        const results = computeSearchResults(drafts, groups, query(), identity);
        const buckets = results.buckets;
        expect(buckets).not.toBeNull();
        if (buckets === null) return;

        expect(buckets.pickedBy).toEqual({
            games: 4,
            wins: 1,
            losses: 1,
            noResult: 1,
            inProgress: 1
        });
        expect(buckets.pickedAgainst).toEqual({
            games: 1,
            wins: 1,
            losses: 0,
            noResult: 0,
            inProgress: 0
        });
        expect(buckets.bannedBy.games).toBe(0);
        expect(buckets.bannedAgainst.games).toBe(0);
    });

    it("bucket filter narrows matches but summaries stay complete", () => {
        const drafts = [
            makeDraft("d1", fullPicks({ 12: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            }),
            makeDraft("d2", fullPicks({ 2: "Jinx" }), {
                group_id: "g1",
                completed: true,
                winner: "blue"
            })
        ];
        const results = computeSearchResults(drafts, groups, query("pickedBy"), identity);

        expect(results.matches.map((m) => m.draftId)).toEqual(["d1"]);
        const buckets = results.buckets;
        expect(buckets).not.toBeNull();
        if (buckets === null) return;
        expect(buckets.pickedBy.games).toBe(1);
        expect(buckets.bannedBy.games).toBe(1);
    });
});
