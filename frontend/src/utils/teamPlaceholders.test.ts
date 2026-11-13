import { describe, it, expect } from "vitest";
import { withoutPlaceholderTeamNames } from "./teamPlaceholders";

describe("withoutPlaceholderTeamNames", () => {
    it("removes the dialog's Team 1 / Team 2 seeds (absent, not null)", () => {
        const result = withoutPlaceholderTeamNames({
            blueTeamName: "Team 1",
            redTeamName: "Team 2",
            length: 3
        });
        expect(result).toEqual({ length: 3 });
        expect("blueTeamName" in result).toBe(false);
        expect("redTeamName" in result).toBe(false);
    });

    it("is trimmed and case-insensitive", () => {
        const result = withoutPlaceholderTeamNames({
            blueTeamName: " team 2 ",
            redTeamName: "TEAM 1"
        });
        expect(result).toEqual({});
    });

    it("removes blank names", () => {
        expect(
            withoutPlaceholderTeamNames({ blueTeamName: "  ", redTeamName: "" })
        ).toEqual({});
    });

    it("keeps real names", () => {
        expect(
            withoutPlaceholderTeamNames({ blueTeamName: "DOG", redTeamName: "Team 10" })
        ).toEqual({ blueTeamName: "DOG", redTeamName: "Team 10" });
    });

    it("removes keys that are present but undefined or non-string", () => {
        const result = withoutPlaceholderTeamNames({
            blueTeamName: undefined,
            redTeamName: "Cats"
        });
        expect("blueTeamName" in result).toBe(false);
        expect(result.redTeamName).toBe("Cats");
    });

    it("does not mutate its input and keeps other keys", () => {
        const input = { blueTeamName: "Team 1", origin: "manual" as const };
        const result = withoutPlaceholderTeamNames(input);
        expect(input.blueTeamName).toBe("Team 1");
        expect(result).toEqual({ origin: "manual" });
    });

    it("handles missing metadata", () => {
        expect(withoutPlaceholderTeamNames(undefined)).toEqual({});
    });
});
