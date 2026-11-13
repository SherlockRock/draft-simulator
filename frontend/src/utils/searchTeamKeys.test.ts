import { describe, expect, it } from "vitest";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import { computeSearchResults, teamSideInDraft, type SearchQuery } from "./canvasSearch";
import {
    buildTeamKeyIndex,
    getOpponentOptions,
    getTeamOptions,
    nextOpponentKey,
    optionKeyForLabel
} from "./searchTeamKeys";

type Team = NonNullable<CanvasGroup["Team1"]>;

const identity = (value: string) => value;

const makeTeam = (id: string, name: string, tournament?: string): Team => ({
    id,
    owner_id: "owner-1",
    name,
    region: "NA",
    ...(tournament !== undefined
        ? { Tournament: { id: `tour-${tournament}`, name: tournament, source: "esclub" } }
        : {})
});

const makeGroup = (
    id: string,
    metadata: CanvasGroup["metadata"] = {},
    teams: { Team1?: Team | null; Team2?: Team | null } = {},
    type: CanvasGroup["type"] = "series"
): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type,
    positionX: 0,
    positionY: 0,
    metadata,
    ...(teams.Team1 !== undefined ? { Team1: teams.Team1 } : {}),
    ...(teams.Team2 !== undefined ? { Team2: teams.Team2 } : {})
});

const makeDraft = (
    id: string,
    groupId: string,
    extra: Partial<CanvasDraft["Draft"]> = {}
): CanvasDraft => ({
    draft_id: id,
    positionX: 0,
    positionY: 0,
    group_id: groupId,
    Draft: {
        id,
        name: id,
        type: "canvas",
        picks: Array.from({ length: 20 }, (_, i) => `Filler${i}`),
        completed: true,
        winner: "blue",
        ...extra
    }
});

const pickupDog = makeTeam("t-pick", "DOG");
const leagueDog = makeTeam("t-league", "DOG", "League 2");
const cat = makeTeam("t-cat", "CAT");

const teamQuery = (
    teamKey: string,
    opponentKey: string | null = null,
    scope: SearchQuery["scope"] = "all"
): SearchQuery => ({ championId: null, teamKey, opponentKey, bucket: null, scope });

const run = (
    drafts: readonly CanvasDraft[],
    groups: readonly CanvasGroup[],
    query: SearchQuery
) => computeSearchResults(drafts, groups, query, identity, buildTeamKeyIndex(groups));

const ids = (results: ReturnType<typeof run>) => results.matches.map((m) => m.draftId);

const options = (groups: readonly CanvasGroup[], scope: SearchQuery["scope"] = "all") =>
    getTeamOptions(buildTeamKeyIndex(groups), groups, scope);

describe("two linked teams named DOG", () => {
    const groups = [
        makeGroup("gA", {}, { Team1: pickupDog, Team2: cat }),
        makeGroup("gB", {}, { Team1: leagueDog, Team2: makeTeam("t-frog", "FROG") })
    ];
    const drafts = [makeDraft("dA", "gA"), makeDraft("dB", "gB")];

    it("are two options with distinct labels", () => {
        expect(options(groups)).toEqual([
            { key: "id:t-cat", label: "CAT" },
            { key: "id:t-pick", label: "DOG" },
            { key: "id:t-league", label: "DOG · League 2" },
            { key: "id:t-frog", label: "FROG" }
        ]);
    });

    it("keep separate records", () => {
        const pickup = run(drafts, groups, teamQuery("id:t-pick"));
        expect(ids(pickup)).toEqual(["dA"]);
        expect(pickup.teamRecord).toMatchObject({ games: 1, wins: 1 });
        const league = run(drafts, groups, teamQuery("id:t-league"));
        expect(ids(league)).toEqual(["dB"]);
    });

    it("a linked DOG's record never includes another DOG's games", () => {
        const both = [...drafts, makeDraft("dA2", "gA", { winner: "red" })];
        const pickup = run(both, groups, teamQuery("id:t-pick"));
        expect(ids(pickup)).toEqual(["dA", "dA2"]);
        expect(pickup.teamRecord).toMatchObject({ games: 2, wins: 1, losses: 1 });
    });
});

describe("folding an unlinked name into a linked team (Q1 A)", () => {
    it("folds unlinked 'dog' into the one linked DOG", () => {
        const groups = [
            makeGroup("gA", {}, { Team1: pickupDog, Team2: cat }),
            makeGroup("gU", { blueTeamName: "dog", redTeamName: "Frog" })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.keysByGroup.get("gU")?.team1).toBe("id:t-pick");
        expect(options(groups).map((o) => o.label)).toEqual(["CAT", "DOG", "Frog"]);
        const drafts = [makeDraft("dA", "gA"), makeDraft("dU", "gU")];
        expect(ids(run(drafts, groups, teamQuery("id:t-pick")))).toEqual(["dA", "dU"]);
    });

    it("folds with trim and any casing", () => {
        const groups = [
            makeGroup("gA", {}, { Team1: makeTeam("t1", "  Dog ") }),
            makeGroup("gU", { blueTeamName: " DOG " })
        ];
        expect(buildTeamKeyIndex(groups).keysByGroup.get("gU")?.team1).toBe("id:t1");
    });

    it("folds into the same team linked in several groups (one distinct id)", () => {
        const groups = [
            makeGroup("gA", {}, { Team1: pickupDog }),
            makeGroup("gB", {}, { Team2: pickupDog }),
            makeGroup("gU", { blueTeamName: "dog" })
        ];
        expect(buildTeamKeyIndex(groups).keysByGroup.get("gU")?.team1).toBe("id:t-pick");
    });

    it("does not fold when two linked DOGs exist; it stays its own option", () => {
        const groups = [
            makeGroup("gA", {}, { Team1: pickupDog, Team2: cat }),
            makeGroup("gB", {}, { Team1: leagueDog }),
            makeGroup("gU", { blueTeamName: "dog", redTeamName: "Frog" })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.keysByGroup.get("gU")?.team1).toBe("name:dog");
        expect(options(groups).map((o) => o.label)).toEqual([
            "CAT",
            "DOG",
            "DOG · League 2",
            "dog (unlinked)",
            "Frog"
        ]);
        const drafts = [
            makeDraft("dA", "gA"),
            makeDraft("dB", "gB"),
            makeDraft("dU", "gU")
        ];
        expect(ids(run(drafts, groups, teamQuery("name:dog")))).toEqual(["dU"]);
        expect(ids(run(drafts, groups, teamQuery("id:t-pick")))).toEqual(["dA"]);
        expect(ids(run(drafts, groups, teamQuery("id:t-league")))).toEqual(["dB"]);
    });

    it("does not fold when no linked team has that name", () => {
        const groups = [
            makeGroup("gA", {}, { Team1: cat }),
            makeGroup("gU", { blueTeamName: "dog" })
        ];
        expect(buildTeamKeyIndex(groups).keysByGroup.get("gU")?.team1).toBe("name:dog");
    });

    it("a team linked only in an unclassified group takes no part in folding", () => {
        const groups = [
            makeGroup("gHidden", {}, { Team1: pickupDog }, "custom"),
            makeGroup("gU", { blueTeamName: "dog" })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.keysByGroup.get("gU")?.team1).toBe("name:dog");
        expect(index.keysByGroup.get("gHidden")).toEqual({ team1: null, team2: null });
    });

    it("consults only the groups it is given (no outside team list)", () => {
        // The signature takes groups and nothing else: an owned or league team
        // that is not linked on this canvas cannot change a key or a label.
        expect(buildTeamKeyIndex.length).toBe(1);
        const groups = [makeGroup("gU", { blueTeamName: "dog", redTeamName: "Frog" })];
        const index = buildTeamKeyIndex(groups);
        expect(index.keysByGroup.get("gU")).toEqual({
            team1: "name:dog",
            team2: "name:frog"
        });
        expect([...index.labelByKey.entries()]).toEqual([
            ["name:dog", "dog"],
            ["name:frog", "Frog"]
        ]);
        // Same answer whatever else exists elsewhere: a second, separate
        // canvas holding DOG does not change this canvas's index.
        const other = [makeGroup("gX", {}, { Team1: pickupDog })];
        expect(buildTeamKeyIndex(other).keysByGroup.get("gX")?.team1).toBe("id:t-pick");
        expect(buildTeamKeyIndex(groups)).toEqual(index);
    });
});

describe("unlinked-only canvases (regression: production's free-text groups)", () => {
    const groups = [
        makeGroup("g1", { blueTeamName: "T1", redTeamName: "GenG" }),
        makeGroup("g2", { blueTeamName: "geng", redTeamName: "DRX" }),
        makeGroup("g3", { blueTeamName: "Team 1", redTeamName: "  " })
    ];
    const drafts = [
        makeDraft("d1", "g1"),
        makeDraft("d2", "g2", { winner: "red" }),
        makeDraft("d3", "g3")
    ];

    it("offers today's options: dedupe case-insensitively, first casing, sorted", () => {
        expect(options(groups).map((o) => o.label)).toEqual(["DRX", "GenG", "T1"]);
        expect(options(groups).map((o) => o.key)).toEqual([
            "name:drx",
            "name:geng",
            "name:t1"
        ]);
    });

    it("gives today's records", () => {
        const geng = run(drafts, groups, teamQuery("name:geng"));
        expect(ids(geng)).toEqual(["d1", "d2"]);
        expect(geng.teamRecord).toMatchObject({ games: 2, wins: 0, losses: 2 });
        expect(ids(run(drafts, groups, teamQuery("name:team 1")))).toEqual([]);
    });
});

describe("a series between team and opponent", () => {
    it("counts once, from the team's perspective", () => {
        const dog2 = makeTeam("t-dog2", "DOG");
        const groups = [makeGroup("gS", {}, { Team1: pickupDog, Team2: dog2 })];
        const drafts = [
            makeDraft("d1", "gS"),
            makeDraft("d2", "gS", { blueSideTeam: 2, winner: "blue" })
        ];
        const results = run(drafts, groups, teamQuery("id:t-dog2", "id:t-pick"));
        expect(ids(results)).toEqual(["d1", "d2"]);
        expect(results.teamRecord).toMatchObject({ games: 2, wins: 1, losses: 1 });
        expect(results.matches[0].teamSide).toBe("red");
    });

    it("an opponent equal to the team never matches", () => {
        const groups = [makeGroup("gS", {}, { Team1: pickupDog, Team2: cat })];
        const results = run(
            [makeDraft("d1", "gS")],
            groups,
            teamQuery("id:t-pick", "id:t-pick")
        );
        expect(results.matches).toEqual([]);
    });

    it("the same key in both slots keeps today's behaviour (team1 wins)", () => {
        const groups = [makeGroup("gS", {}, { Team1: pickupDog, Team2: pickupDog })];
        const index = buildTeamKeyIndex(groups);
        const draft = makeDraft("d1", "gS");
        expect(teamSideInDraft(draft, groups[0], "id:t-pick", index)).toBe("blue");
        const swapped = makeDraft("d2", "gS", { blueSideTeam: 2 });
        expect(teamSideInDraft(swapped, groups[0], "id:t-pick", index)).toBe("red");
    });
});

describe("labels", () => {
    it("two pickup DOGs without a tournament get DOG / DOG · 2 in id order", () => {
        const groups = [
            makeGroup("g1", {}, { Team1: makeTeam("t-b", "DOG") }),
            makeGroup("g2", {}, { Team1: makeTeam("t-a", "DOG") })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.labelByKey.get("id:t-a")).toBe("DOG");
        expect(index.labelByKey.get("id:t-b")).toBe("DOG · 2");
    });

    it("three DOGs get DOG, DOG · 2, DOG · 3", () => {
        const groups = [
            makeGroup(
                "g1",
                {},
                { Team1: makeTeam("t-c", "DOG"), Team2: makeTeam("t-b", "DOG") }
            ),
            makeGroup("g2", {}, { Team1: makeTeam("t-a", "DOG") })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.labelByKey.get("id:t-a")).toBe("DOG");
        expect(index.labelByKey.get("id:t-b")).toBe("DOG · 2");
        expect(index.labelByKey.get("id:t-c")).toBe("DOG · 3");
    });

    it("two same-named rosters of one league are numbered after the tournament", () => {
        const groups = [
            makeGroup(
                "g1",
                {},
                {
                    Team1: makeTeam("t-1", "DOG", "League 2"),
                    Team2: makeTeam("t-2", "DOG", "League 2")
                }
            )
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.labelByKey.get("id:t-1")).toBe("DOG · League 2");
        expect(index.labelByKey.get("id:t-2")).toBe("DOG · League 2 · 2");
    });

    it("the last guard keeps a team literally named like another's label unique", () => {
        // League DOG becomes "DOG · League 2" because it clashes with the pickup
        // DOG; a third team is literally called "DOG · League 2".
        const groups = [
            makeGroup(
                "g1",
                {},
                {
                    Team1: makeTeam("t-1", "DOG", "League 2"),
                    Team2: makeTeam("t-2", "DOG")
                }
            ),
            makeGroup("g2", {}, { Team1: makeTeam("t-3", "DOG · League 2") })
        ];
        const labels = [...buildTeamKeyIndex(groups).labelByKey.values()];
        expect(labels).toHaveLength(3);
        expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(3);
    });

    it("a lone team keeps its bare name even in a league", () => {
        const groups = [makeGroup("g1", {}, { Team1: leagueDog })];
        expect(buildTeamKeyIndex(groups).labelByKey.get("id:t-league")).toBe("DOG");
    });

    it("labels are unique across the index", () => {
        const groups = [
            makeGroup(
                "g1",
                { blueTeamName: "dog", redTeamName: "Dog (unlinked)" },
                {
                    Team1: pickupDog,
                    Team2: makeTeam("t-x", "DOG")
                }
            ),
            makeGroup(
                "g2",
                {},
                {
                    Team1: leagueDog,
                    Team2: makeTeam("t-y", "DOG", "League 2")
                }
            ),
            makeGroup("g3", { blueTeamName: "DOG", redTeamName: "cat" }, { Team2: cat })
        ];
        const index = buildTeamKeyIndex(groups);
        const labels = [...index.labelByKey.values()].map((l) => l.toLowerCase());
        expect(new Set(labels).size).toBe(labels.length);
        const offered = options(groups).map((o) => o.label.toLowerCase());
        expect(new Set(offered).size).toBe(offered.length);
    });

    it("keys and labels do not change with scope; options only filter", () => {
        const groups = [
            makeGroup("gO", { gameType: "official" }, { Team1: pickupDog }),
            makeGroup("gS", { gameType: "scratch" }, { Team1: leagueDog })
        ];
        const index = buildTeamKeyIndex(groups);
        expect(index.labelByKey.get("id:t-pick")).toBe("DOG");
        expect(index.labelByKey.get("id:t-league")).toBe("DOG · League 2");
        expect(options(groups, "official")).toEqual([{ key: "id:t-pick", label: "DOG" }]);
        expect(options(groups, "scratch")).toEqual([
            { key: "id:t-league", label: "DOG · League 2" }
        ]);
        // scratch-only team: the "all" list carries no scratch teams, but the
        // label is the same as under its own scope
        expect(options(groups, "all")).toEqual([{ key: "id:t-pick", label: "DOG" }]);
    });
});

describe("options and scope", () => {
    it("offers a key only if a group the scope counts holds it", () => {
        const groups = [
            makeGroup("gO", {
                blueTeamName: "A",
                redTeamName: "B",
                gameType: "official"
            }),
            makeGroup("gC", { blueTeamName: "C", redTeamName: "D" }, {}, "custom")
        ];
        expect(options(groups).map((o) => o.label)).toEqual(["A", "B"]);
    });

    it("drops placeholders and blanks", () => {
        const groups = [
            makeGroup("g1", { blueTeamName: " Team 1 ", redTeamName: "TEAM 2" }),
            makeGroup("g2", { blueTeamName: "  ", redTeamName: "DOG" })
        ];
        expect(options(groups).map((o) => o.label)).toEqual(["DOG"]);
    });

    it("getOpponentOptions drops the selected key", () => {
        const groups = [makeGroup("gA", {}, { Team1: pickupDog, Team2: cat })];
        const index = buildTeamKeyIndex(groups);
        expect(getOpponentOptions(index, groups, "all", "id:t-pick")).toEqual([
            { key: "id:t-cat", label: "CAT" }
        ]);
    });

    it("sorts by label", () => {
        const groups = [makeGroup("g1", { blueTeamName: "zed", redTeamName: "Alpha" })];
        expect(options(groups).map((o) => o.label)).toEqual(["Alpha", "zed"]);
    });
});

describe("optionKeyForLabel and nextOpponentKey", () => {
    const opts = [
        { key: "id:t-pick", label: "DOG" },
        { key: "id:t-league", label: "DOG · League 2" }
    ];

    it("maps a label back to its key, null when unknown or empty", () => {
        expect(optionKeyForLabel(opts, "DOG · League 2")).toBe("id:t-league");
        expect(optionKeyForLabel(opts, "DOG")).toBe("id:t-pick");
        expect(optionKeyForLabel(opts, "dog")).toBeNull();
        expect(optionKeyForLabel(opts, "")).toBeNull();
    });

    it("keeps the opponent unless team is null or the same key", () => {
        expect(nextOpponentKey("id:a", "id:b")).toBe("id:b");
        expect(nextOpponentKey("id:a", "id:a")).toBeNull();
        expect(nextOpponentKey(null, "id:b")).toBeNull();
        expect(nextOpponentKey("id:a", null)).toBeNull();
    });
});
