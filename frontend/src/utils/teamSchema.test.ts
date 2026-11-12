import { describe, it, expect } from "vitest";
import { TeamSchema, TeamListRowSchema } from "@draft-sim/shared-types";

const pickup = {
    id: "t1",
    owner_id: "u1",
    name: "MEOW",
    region: "na1",
    TeamPlayers: [],
    canEditRoster: true
};

const imported = {
    id: "t2",
    owner_id: null,
    name: "Team Imported",
    region: "euw1",
    tournament_id: "tour1",
    source: "esclub",
    acronym: "TI",
    colors: { primary: "#112233", secondary: "#445566" },
    archived_at: null,
    Tournament: { id: "tour1", name: "Spring Cup", source: "esclub" },
    canEditRoster: false
};

describe("TeamListRowSchema", () => {
    it("parses a pickup row", () => {
        const row = TeamListRowSchema.parse(pickup);
        expect(row.canEditRoster).toBe(true);
        expect(row.owner_id).toBe("u1");
    });

    it("parses an imported row with a null owner and a tournament", () => {
        const row = TeamListRowSchema.parse(imported);
        expect(row.owner_id).toBeNull();
        expect(row.source).toBe("esclub");
        expect(row.Tournament?.name).toBe("Spring Cup");
        expect(row.canEditRoster).toBe(false);
    });

    it("accepts a null Tournament (Sequelize sends null for a missing belongsTo)", () => {
        expect(TeamListRowSchema.safeParse({ ...pickup, Tournament: null }).success).toBe(
            true
        );
    });

    it("accepts an unknown source string", () => {
        expect(
            TeamListRowSchema.safeParse({ ...pickup, source: "somewhere-new" }).success
        ).toBe(true);
    });

    it("rejects a list row without canEditRoster", () => {
        const withoutFlag = Object.fromEntries(
            Object.entries(pickup).filter(([key]) => key !== "canEditRoster")
        );
        expect(TeamListRowSchema.safeParse(withoutFlag).success).toBe(false);
    });
});

describe("TeamSchema (canvas payload team)", () => {
    it("parses a team without canEditRoster", () => {
        const withoutFlag = Object.fromEntries(
            Object.entries(pickup).filter(([key]) => key !== "canEditRoster")
        );
        expect(TeamSchema.safeParse(withoutFlag).success).toBe(true);
    });

    it("parses an imported team with a null owner", () => {
        expect(TeamSchema.safeParse(imported).success).toBe(true);
    });
});
