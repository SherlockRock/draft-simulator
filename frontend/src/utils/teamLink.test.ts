import { describe, it, expect } from "vitest";
import { findTeamByName, resolveTeamLink } from "./teamLink";
import type { Team } from "@draft-sim/shared-types";

const team = (id: string, name: string): Team => ({
    id,
    owner_id: "u",
    name,
    region: "na1",
    TeamPlayers: []
});

const teams = [team("t-meow", "MEOW"), team("t-tsr", "TSR")];

describe("findTeamByName", () => {
    it("finds an exact match", () => {
        expect(findTeamByName("MEOW", teams)?.id).toBe("t-meow");
    });

    it("matches case-insensitively and ignores padding", () => {
        expect(findTeamByName("  meow ", teams)?.id).toBe("t-meow");
    });

    it("does not match a prefix", () => {
        expect(findTeamByName("ME", teams)).toBeNull();
    });

    it("refuses to guess between two owned teams sharing a name", () => {
        const dupes = [...teams, team("t-meow-kr", "meow")];
        expect(findTeamByName("MEOW", dupes)).toBeNull();
    });

    it("never infers from the dialog's placeholder names", () => {
        const withDefaults = [...teams, team("t-1", "Team 1"), team("t-2", "Team 2")];
        expect(findTeamByName("Team 1", withDefaults)).toBeNull();
        expect(findTeamByName("team 2", withDefaults)).toBeNull();
    });

    it("returns null for an empty name", () => {
        expect(findTeamByName("   ", teams)).toBeNull();
    });
});

describe("resolveTeamLink", () => {
    it("keeps an explicitly chosen id even when the name matches another team", () => {
        expect(resolveTeamLink("MEOW", "t-tsr", teams, "Team 1")).toEqual({
            name: "MEOW",
            teamId: "t-tsr"
        });
    });

    it("links a typed name that matches one owned team", () => {
        expect(resolveTeamLink("MEOW", null, teams, "Team 1")).toEqual({
            name: "MEOW",
            teamId: "t-meow"
        });
    });

    it("adopts the entity's casing so header and dialog agree", () => {
        expect(resolveTeamLink("meow", null, teams, "Team 1")).toEqual({
            name: "MEOW",
            teamId: "t-meow"
        });
    });

    it("leaves an unmatched name as free text", () => {
        expect(resolveTeamLink("Fnatic", null, teams, "Team 1")).toEqual({
            name: "Fnatic",
            teamId: null
        });
    });

    it("does not link the untouched placeholder name", () => {
        const withDefault = [...teams, team("t-1", "Team 1")];
        expect(resolveTeamLink("Team 1", null, withDefault, "Team 1")).toEqual({
            name: "Team 1",
            teamId: null
        });
    });

    it("falls back to the placeholder when the field was cleared", () => {
        expect(resolveTeamLink("   ", null, teams, "Team 2")).toEqual({
            name: "Team 2",
            teamId: null
        });
    });

    it("links nothing when the user has no teams (local/anonymous canvas)", () => {
        expect(resolveTeamLink("MEOW", null, [], "Team 1")).toEqual({
            name: "MEOW",
            teamId: null
        });
    });
});
