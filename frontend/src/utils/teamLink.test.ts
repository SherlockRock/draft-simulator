import { describe, it, expect } from "vitest";
import { resolveTeamIdByName } from "./teamLink";
import type { Team } from "@draft-sim/shared-types";

const team = (id: string, name: string): Team => ({
    id,
    owner_id: "u",
    name,
    region: "na1",
    TeamPlayers: []
});

const teams = [team("t-meow", "MEOW"), team("t-tsr", "TSR")];

describe("resolveTeamIdByName", () => {
    it("keeps an explicitly chosen id", () => {
        expect(resolveTeamIdByName("MEOW", "t-tsr", teams)).toBe("t-tsr");
    });

    it("links a typed name that exactly matches an owned team", () => {
        expect(resolveTeamIdByName("MEOW", null, teams)).toBe("t-meow");
    });

    it("matches case-insensitively and ignores padding", () => {
        expect(resolveTeamIdByName("  meow ", null, teams)).toBe("t-meow");
    });

    it("leaves an unmatched name as free text", () => {
        expect(resolveTeamIdByName("Team 1", null, teams)).toBeNull();
    });

    it("does not link on a partial match", () => {
        expect(resolveTeamIdByName("ME", null, teams)).toBeNull();
    });

    it("returns null for an empty name", () => {
        expect(resolveTeamIdByName("   ", null, teams)).toBeNull();
    });

    it("returns null when the user has no teams (local/anonymous canvas)", () => {
        expect(resolveTeamIdByName("MEOW", null, [])).toBeNull();
    });
});
