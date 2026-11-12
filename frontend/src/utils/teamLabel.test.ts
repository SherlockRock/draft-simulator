import { describe, it, expect } from "vitest";
import type { Team, TeamListRow } from "@draft-sim/shared-types";
import { mergeTeamIntoList, teamOptionLabel } from "./teamLabel";

const row = (overrides: Partial<TeamListRow> = {}): TeamListRow => ({
    id: "t-1",
    owner_id: "u",
    name: "DOG",
    region: "na1",
    TeamPlayers: [],
    canEditRoster: true,
    ...overrides
});

describe("teamOptionLabel", () => {
    it("is the plain name for a pickup team", () => {
        expect(teamOptionLabel(row())).toBe("DOG");
        expect(teamOptionLabel(row({ Tournament: null }))).toBe("DOG");
    });

    it("appends the tournament name for a tournament team", () => {
        const team = row({
            canEditRoster: false,
            Tournament: { id: "x", name: "Season 9", source: "esclub" }
        });
        expect(teamOptionLabel(team)).toBe("DOG · Season 9");
    });
});

describe("mergeTeamIntoList", () => {
    const cachedImported = row({
        canEditRoster: false,
        Tournament: { id: "x", name: "Season 9", source: "esclub" }
    });

    it("keeps the cached flag and tournament when the response lacks them", () => {
        const fresh: Team = {
            id: "t-1",
            owner_id: null,
            name: "DOG2",
            region: "na1"
        };
        const merged = mergeTeamIntoList([cachedImported], fresh);
        expect(merged[0].name).toBe("DOG2");
        expect(merged[0].canEditRoster).toBe(false);
        expect(merged[0].Tournament?.name).toBe("Season 9");
    });

    it("takes the server's flag and tournament when it sends them", () => {
        const fresh = row({ canEditRoster: true, Tournament: null });
        const merged = mergeTeamIntoList([cachedImported], fresh);
        expect(merged[0].canEditRoster).toBe(true);
        expect(merged[0].Tournament).toBeNull();
    });

    it("leaves other rows alone", () => {
        const other = row({ id: "t-2", name: "OTHER" });
        expect(mergeTeamIntoList([other, cachedImported], row())[0]).toBe(other);
    });
});
