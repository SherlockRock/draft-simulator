import { describe, it, expect } from "vitest";
import {
    ManagedTeamRowSchema,
    ManagedTournamentSchema,
    TeamsManageResponseSchema
} from "@draft-sim/shared-types";

const without = (row: object, key: string) =>
    Object.fromEntries(Object.entries(row).filter(([entryKey]) => entryKey !== key));

const zeroCounts = { official: 0, scrim: 0, scratch: 0, total: 0 };

const pickup = {
    id: "t1",
    owner_id: "u1",
    name: "MEOW",
    region: "na1",
    source: "manual",
    tournament_id: null,
    archived_at: null,
    TeamPlayers: [],
    Tournament: null,
    canEditRoster: true,
    leagueRecord: null,
    useCounts: { official: 4, scrim: 12, scratch: 1, total: 17 },
    canArchive: true,
    canDelete: true
};

const archivedPickup = {
    ...pickup,
    id: "t2",
    name: "OLD",
    archived_at: "2026-10-02T00:00:00.000Z",
    leagueRecord: null,
    useCounts: zeroCounts
};

const imported = {
    id: "t3",
    owner_id: null,
    name: "Team Imported",
    region: "euw1",
    tournament_id: "tour1",
    source: "esclub",
    archived_at: null,
    Tournament: { id: "tour1", name: "Spring Cup", source: "esclub" },
    canEditRoster: false,
    leagueRecord: null,
    useCounts: { official: 2, scrim: 0, scratch: 0, total: 2 },
    canArchive: false,
    canDelete: false
};

const activeTournament = {
    id: "tour1",
    name: "Spring Cup",
    source: "esclub",
    region: "euw1",
    archived_at: null
};
const archivedTournament = {
    id: "tour2",
    name: "Fall Cup",
    source: "esclub",
    region: "na1",
    archived_at: "2026-10-01T00:00:00.000Z"
};
const emptyTournament = {
    id: "tour3",
    name: "Empty League",
    source: "esclub",
    region: "kr",
    archived_at: null
};

describe("ManagedTeamRowSchema", () => {
    it("parses a pickup row", () => {
        const row = ManagedTeamRowSchema.parse(pickup);
        expect(row.useCounts.total).toBe(17);
        expect(row.canArchive).toBe(true);
        expect(row.canDelete).toBe(true);
    });

    it("parses an archived pickup row", () => {
        const row = ManagedTeamRowSchema.parse(archivedPickup);
        expect(row.archived_at).toBe("2026-10-02T00:00:00.000Z");
        expect(row.useCounts).toEqual(zeroCounts);
    });

    it("parses an imported row that can be neither archived nor deleted", () => {
        const row = ManagedTeamRowSchema.parse(imported);
        expect(row.canArchive).toBe(false);
        expect(row.canDelete).toBe(false);
        expect(row.canEditRoster).toBe(false);
        expect(row.Tournament?.name).toBe("Spring Cup");
    });

    it("requires a nullable record with nonnegative integer counters", () => {
        expect(
            ManagedTeamRowSchema.safeParse(without(pickup, "leagueRecord")).success
        ).toBe(false);
        const leagueRecord = { series: { won: 5, lost: 1 }, games: { won: 11, lost: 4 } };
        expect(
            ManagedTeamRowSchema.parse({ ...imported, leagueRecord }).leagueRecord
        ).toEqual(leagueRecord);
        expect(
            ManagedTeamRowSchema.safeParse({
                ...imported,
                leagueRecord: { ...leagueRecord, games: { won: -1, lost: 0 } }
            }).success
        ).toBe(false);
        expect(
            ManagedTeamRowSchema.safeParse({
                ...imported,
                leagueRecord: { ...leagueRecord, series: { won: 1.5, lost: 0 } }
            }).success
        ).toBe(false);
    });

    it("rejects a row without useCounts", () => {
        expect(ManagedTeamRowSchema.safeParse(without(pickup, "useCounts")).success).toBe(
            false
        );
    });

    it("rejects a row without canArchive or canDelete", () => {
        expect(
            ManagedTeamRowSchema.safeParse(without(pickup, "canArchive")).success
        ).toBe(false);
        expect(ManagedTeamRowSchema.safeParse(without(pickup, "canDelete")).success).toBe(
            false
        );
    });

    it("rejects useCounts missing a bucket", () => {
        const useCounts = { official: 1, scrim: 1, total: 2 };
        expect(ManagedTeamRowSchema.safeParse({ ...pickup, useCounts }).success).toBe(
            false
        );
    });
});

describe("ManagedTournamentSchema", () => {
    it("parses active and archived tournaments", () => {
        expect(ManagedTournamentSchema.parse(activeTournament).archived_at).toBeNull();
        expect(ManagedTournamentSchema.parse(archivedTournament).archived_at).toBe(
            "2026-10-01T00:00:00.000Z"
        );
    });

    it("tolerates a source and region it does not know", () => {
        const odd = { ...activeTournament, source: "somewhere-new", region: "zz9" };
        expect(ManagedTournamentSchema.safeParse(odd).success).toBe(true);
    });

    it("rejects a missing archived_at", () => {
        expect(
            ManagedTournamentSchema.safeParse(without(activeTournament, "archived_at"))
                .success
        ).toBe(false);
    });
});

describe("TeamsManageResponseSchema", () => {
    it("parses tournaments (archived and empty included) with pickup, archived and imported rows", () => {
        const body = TeamsManageResponseSchema.parse({
            tournaments: [activeTournament, archivedTournament, emptyTournament],
            teams: [pickup, archivedPickup, imported]
        });
        expect(body.tournaments).toHaveLength(3);
        expect(body.teams.map((team) => team.id)).toEqual(["t1", "t2", "t3"]);
    });

    it("parses an empty response", () => {
        expect(
            TeamsManageResponseSchema.safeParse({ tournaments: [], teams: [] }).success
        ).toBe(true);
    });
});
