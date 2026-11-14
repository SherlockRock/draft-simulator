import { describe, expect, it } from "vitest";
import { CanvasGroupSchema } from "./schemas";
import { buildTeamKeyIndex } from "./searchTeamKeys";

// S3 plan D13 / Task 4: a group built by the league send links both teams by
// id from the start (ruling 1), so search keys both slots by `id:`. The group
// is shaped as the send writes it (team1_id/team2_id, metadata as planSend
// makes it) and as the canvas payload carries it (Team1/Team2 with their
// Tournament, LeagueImport), then parsed by the client's schema.

const TEAM1 = "aaaaaaaa-0000-4000-8000-000000000002";
const TEAM2 = "aaaaaaaa-0000-4000-8000-000000000001";
const TOURNAMENT = "dddddddd-0000-4000-8000-000000000001";

const leagueTeam = (id: string, name: string) => ({
    id,
    owner_id: null,
    name,
    region: "EUW",
    tournament_id: TOURNAMENT,
    source: "esclub",
    Tournament: { id: TOURNAMENT, name: "League 2", source: "esclub" }
});

const sentGroup = CanvasGroupSchema.parse({
    id: "g-sent",
    canvas_id: "canvas-1",
    name: "Zeta Wolves vs Alpha Owls",
    type: "series",
    positionX: 400,
    positionY: 300,
    versus_draft_id: "vd-1",
    // Fix 7: LeagueSeries.team1 is team1 here and in metadata.blueTeamName.
    team1_id: TEAM1,
    team2_id: TEAM2,
    Team1: leagueTeam(TEAM1, "Zeta Wolves"),
    Team2: leagueTeam(TEAM2, "Alpha Owls"),
    LeagueImport: {
        leagueSeriesId: "bbbbbbbb-0000-4000-8000-000000000001",
        tournamentId: TOURNAMENT,
        stageName: "Regular Season",
        startsAt: "2026-11-11T18:00:00.000Z",
        status: "finished",
        complete: true,
        esclubUrl: "https://example.invalid/serie/1"
    },
    metadata: {
        blueTeamName: "Zeta Wolves",
        redTeamName: "Alpha Owls",
        length: 3,
        competitive: true,
        seriesType: "fearless",
        draftMode: "fearless",
        origin: "manual",
        disabledChampions: [],
        gameType: "official"
    }
});

describe("search keys of a group sent from the league", () => {
    it("keys both slots by team id, team1 being the series' team1", () => {
        const index = buildTeamKeyIndex([sentGroup]);
        expect(index.keysByGroup.get("g-sent")).toEqual({
            team1: `id:${TEAM1}`,
            team2: `id:${TEAM2}`
        });
        expect(index.labelByKey.get(`id:${TEAM1}`)).toContain("Zeta Wolves");
        expect(index.labelByKey.get(`id:${TEAM2}`)).toContain("Alpha Owls");
    });

    it("still keys by id when the payload omits the Team rows (ids alone)", () => {
        const bare = CanvasGroupSchema.parse({
            ...sentGroup,
            id: "g-bare",
            Team1: null,
            Team2: null
        });
        expect(buildTeamKeyIndex([bare]).keysByGroup.get("g-bare")).toEqual({
            team1: `id:${TEAM1}`,
            team2: `id:${TEAM2}`
        });
    });
});
