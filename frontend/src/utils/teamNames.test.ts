import { describe, expect, it } from "vitest";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import { fieldForColumn, resolveTeamNames } from "./teamNames";

const makeCard = (
    overrides: Partial<CanvasDraft> = {},
    blueSideTeam: 1 | 2 = 1
): CanvasDraft => ({
    positionX: 0,
    positionY: 0,
    group_id: null,
    Draft: {
        id: "d1",
        name: "d1",
        type: "canvas",
        picks: Array.from({ length: 20 }, () => ""),
        blueSideTeam
    },
    ...overrides
});

const makeGroup = (
    metadata: CanvasGroup["metadata"] = {},
    teams: { Team1?: CanvasGroup["Team1"]; Team2?: CanvasGroup["Team2"] } = {}
): CanvasGroup => ({
    id: "g1",
    canvas_id: "c1",
    name: "g1",
    type: "series",
    positionX: 0,
    positionY: 0,
    metadata,
    ...(teams.Team1 !== undefined ? { Team1: teams.Team1 } : {}),
    ...(teams.Team2 !== undefined ? { Team2: teams.Team2 } : {})
});

const team = (id: string, name: string): CanvasGroup["Team1"] => ({
    id,
    owner_id: "o1",
    name,
    region: "NA"
});

describe("resolveTeamNames", () => {
    it("returns undefined labels when nothing is set", () => {
        expect(resolveTeamNames(makeCard())).toEqual({
            left: undefined,
            right: undefined
        });
    });

    it("uses group metadata when the card has no override", () => {
        const group = makeGroup({ blueTeamName: "T1", redTeamName: "GenG" });
        expect(resolveTeamNames(makeCard(), group)).toEqual({
            left: "T1",
            right: "GenG"
        });
    });

    it("prefers a linked Team entity over metadata", () => {
        const group = makeGroup(
            { blueTeamName: "stale", redTeamName: "also stale" },
            { Team1: team("t1", "T1"), Team2: team("t2", "GenG") }
        );
        expect(resolveTeamNames(makeCard(), group)).toEqual({
            left: "T1",
            right: "GenG"
        });
    });

    it("prefers the card override over everything", () => {
        const group = makeGroup(
            { blueTeamName: "T1", redTeamName: "GenG" },
            { Team1: team("t1", "T1") }
        );
        const card = makeCard({ team1Name: "T1 (Poby)" });
        expect(resolveTeamNames(card, group)).toEqual({
            left: "T1 (Poby)",
            right: "GenG"
        });
    });

    it("treats empty and whitespace-only overrides as inherit", () => {
        const group = makeGroup({ blueTeamName: "T1", redTeamName: "GenG" });
        expect(resolveTeamNames(makeCard({ team1Name: "" }), group).left).toBe("T1");
        expect(resolveTeamNames(makeCard({ team1Name: "   " }), group).left).toBe("T1");
        expect(resolveTeamNames(makeCard({ team1Name: null }), group).left).toBe("T1");
    });

    it("swaps columns when blueSideTeam is 2", () => {
        const group = makeGroup({ blueTeamName: "T1", redTeamName: "GenG" });
        expect(resolveTeamNames(makeCard({}, 2), group)).toEqual({
            left: "GenG",
            right: "T1"
        });
    });

    it("swaps a card override with the sides too", () => {
        const group = makeGroup({ blueTeamName: "T1", redTeamName: "GenG" });
        const card = makeCard({ team1Name: "T1 (Poby)" }, 2);
        expect(resolveTeamNames(card, group)).toEqual({
            left: "GenG",
            right: "T1 (Poby)"
        });
    });

    it("works with no group at all (standalone card)", () => {
        const card = makeCard({ team1Name: "Us", team2Name: "Them" });
        expect(resolveTeamNames(card)).toEqual({ left: "Us", right: "Them" });
    });
});

describe("fieldForColumn", () => {
    it("maps columns to identity fields through blueSideTeam", () => {
        expect(fieldForColumn("left", 1)).toBe("team1Name");
        expect(fieldForColumn("right", 1)).toBe("team2Name");
        expect(fieldForColumn("left", 2)).toBe("team2Name");
        expect(fieldForColumn("right", 2)).toBe("team1Name");
    });

    it("defaults to team1 on blue when blueSideTeam is absent", () => {
        expect(fieldForColumn("left", undefined)).toBe("team1Name");
    });
});
