import { describe, it, expect } from "vitest";
import { buildScoutLink, rosterToSlots, scoutLinkPath } from "./scoutLink";
import { parseTeamParam } from "./playerStats";
import type { Team, TeamPlayer } from "@draft-sim/shared-types";

const player = (
    gameName: string,
    tagLine: string,
    role: TeamPlayer["role"],
    ordinal: number
): TeamPlayer => ({
    id: `${gameName}-${ordinal}`,
    team_id: "t",
    role,
    gameName,
    tagLine,
    ordinal
});

const team = (
    region: string,
    players: TeamPlayer[],
    overrides: Partial<Team> = {}
): Team => ({
    id: "t",
    owner_id: "u",
    name: "Team",
    region,
    TeamPlayers: players,
    ...overrides
});

describe("rosterToSlots", () => {
    it("places roled players into ROLE_ORDER slots, leaving gaps null", () => {
        const slots = rosterToSlots([
            player("Kiin", "KR1", "top", 0),
            player("Faker", "KR1", "mid", 1)
        ]);
        expect(slots.map((s) => s?.gameName ?? null)).toEqual([
            "Kiin",
            null,
            "Faker",
            null,
            null
        ]);
    });

    it("ignores bench (null-role) players", () => {
        const slots = rosterToSlots([player("Sub", "KR1", null, 0)]);
        expect(slots.every((s) => s === null)).toBe(true);
    });
});

describe("buildScoutLink", () => {
    it("returns null when neither team has players", () => {
        expect(buildScoutLink(team("na1", []), team("na1", []))).toBeNull();
        expect(buildScoutLink(null, null)).toBeNull();
    });

    it("single team with roles → slot-form players, team region", () => {
        const t = team("kr", [
            player("Kiin", "KR1", "top", 0),
            player("Faker", "KR2", "mid", 1)
        ]);
        const link = buildScoutLink(t, null);
        expect(link).toEqual({
            region: "kr",
            players: "s:Kiin#KR1,,Faker#KR2,,",
            team: "t"
        });
    });

    // Decision 42: an all-bench roster is the shape of any freshly pasted team,
    // so stopping at five here would make the bench unreachable from a linked
    // team. List-form, not slot-form — slot-form would bypass autoAssignRoles
    // and roles would come from ordinal order.
    it("single team, no roles set → list-form of the WHOLE roster by ordinal", () => {
        const t = team("na1", [
            player("F", "1", null, 5),
            player("A", "1", null, 0),
            player("B", "1", null, 1),
            player("C", "1", null, 2),
            player("D", "1", null, 3),
            player("E", "1", null, 4)
        ]);
        const link = buildScoutLink(t, null);
        expect(link?.players).toBe("A#1,B#1,C#1,D#1,E#1,F#1");
        expect(link?.region).toBe("na1");
    });

    it("caps the no-roles list at MAX_ROSTER", () => {
        const t = team(
            "na1",
            Array.from({ length: 12 }, (_, i) => player(`P${i}`, "1", null, i))
        );
        expect(buildScoutLink(t, null)?.players.split(",")).toHaveLength(10);
    });

    it("emits unroled players as the bench after the slots", () => {
        const t = team("kr", [
            player("Kiin", "KR1", "top", 0),
            player("Faker", "KR2", "mid", 1),
            player("Sub1", "KR3", null, 2),
            player("Sub2", "KR4", null, 3)
        ]);
        expect(buildScoutLink(t, null)?.players).toBe(
            "s:Kiin#KR1,,Faker#KR2,,,Sub1#KR3,Sub2#KR4"
        );
    });

    // "Bench" means NOT PLACED in a slot, not `role === null`: only the first
    // match per role is placed, so a second row with the same role would
    // otherwise vanish from the link entirely.
    it("benches a duplicate-role row rather than dropping it", () => {
        const t = team("na1", [
            player("First", "1", "top", 0),
            player("Second", "1", "top", 1)
        ]);
        expect(buildScoutLink(t, null)?.players).toBe("s:First#1,,,,,Second#1");
    });

    it("only team2 has players → single-team in players slot, team2 region", () => {
        const t2 = team("euw1", [player("Caps", "EUW", "mid", 0)]);
        const link = buildScoutLink(team("na1", []), t2);
        expect(link).toEqual({
            region: "euw1",
            players: "s:,,Caps#EUW,,",
            team: "t"
        });
        expect(link?.enemies).toBeUndefined();
    });

    it("both teams → matchup, enemyRegion omitted when equal", () => {
        const t1 = team("kr", [player("Kiin", "KR1", "top", 0)]);
        const t2 = team("kr", [player("Zeus", "KR1", "top", 0)]);
        const link = buildScoutLink(t1, t2);
        expect(link?.players).toBe("s:Kiin#KR1,,,,");
        expect(link?.enemies).toBe("s:Zeus#KR1,,,,");
        expect(link?.region).toBe("kr");
        expect(link?.enemyRegion).toBeUndefined();
    });

    it("both teams, different regions → enemyRegion set", () => {
        const t1 = team("kr", [player("Kiin", "KR1", "top", 0)]);
        const t2 = team("euw1", [player("Zeus", "EUW", "top", 0)]);
        const link = buildScoutLink(t1, t2);
        expect(link?.enemyRegion).toBe("euw1");
    });

    it("preserves # and , in names via the codec (no double-encode here)", () => {
        const t = team("na1", [player("na,me", "ta#g", "top", 0)]);
        const link = buildScoutLink(t, null);
        // codec percent-encodes the inner name/tag; separators stay literal
        expect(link?.players).toBe("s:na%2Cme#ta%23g,,,,");
    });

    // Guards the load-bearing boundary: the params object must survive a
    // URLSearchParams round-trip (how the caller builds /scout?...) and a single
    // decode (what solid-router's useSearchParams gives ScoutView) back into the
    // original Riot IDs. This is the claim the whole "return an object" design
    // rests on.
    it("round-trips through URLSearchParams + one decode back to the players", () => {
        const t = team("na1", [player("na,me", "ta#g", "top", 0)]);
        const link = buildScoutLink(t, null);
        if (!link) throw new Error("expected a link");

        const usp = new URLSearchParams();
        usp.set("players", link.players);
        // URLSearchParams.get() applies exactly one decode — the same single layer
        // solid-router applies when reading the query.
        const decodedOnce = new URLSearchParams(usp.toString()).get("players");
        expect(decodedOnce).toBe(link.players);

        const slots = parseTeamParam(decodedOnce ?? "");
        expect(slots.kind).toBe("slots");
        if (slots.kind === "slots") {
            expect(slots.slots[0]).toEqual({ gameName: "na,me", tagLine: "ta#g" });
        }
    });
});

describe("buildScoutLink team ids", () => {
    it("names the sole rostered team even when it sat in slot 2", () => {
        const team2 = team("kr", [player("Faker", "KR1", "mid", 0)], { id: "t-two" });
        const link = buildScoutLink(null, team2);
        // The roster is promoted into `players`, so `team` must follow it.
        expect(link?.team).toBe("t-two");
        expect(link?.enemyTeam).toBeUndefined();
    });

    it("names both teams in a matchup", () => {
        const link = buildScoutLink(
            team("na1", [player("Alice", "NA1", "top", 0)], { id: "t-one" }),
            team("na1", [player("Bob", "NA1", "top", 0)], { id: "t-two" })
        );
        expect(link?.team).toBe("t-one");
        expect(link?.enemyTeam).toBe("t-two");
    });

    it("serializes both ids into the path", () => {
        const url = new URL(
            scoutLinkPath({
                region: "na1",
                players: "s:a#NA1,,,,",
                team: "t-one",
                enemyTeam: "t-two"
            }),
            "https://example.com"
        );
        expect(url.searchParams.get("team")).toBe("t-one");
        expect(url.searchParams.get("enemyTeam")).toBe("t-two");
    });

    it("omits the ids when no team is linked", () => {
        const url = new URL(
            scoutLinkPath({ region: "na1", players: "a#NA1" }),
            "https://example.com"
        );
        expect(url.searchParams.has("team")).toBe(false);
        expect(url.searchParams.has("enemyTeam")).toBe(false);
    });
});

describe("scoutLinkPath", () => {
    it("builds a single-team /scout path with region + players", () => {
        const path = scoutLinkPath({ region: "kr", players: "s:Kiin#KR1,,,," });
        const url = new URL(path, "https://x");
        expect(url.pathname).toBe("/scout");
        expect(url.searchParams.get("region")).toBe("kr");
        expect(url.searchParams.get("players")).toBe("s:Kiin#KR1,,,,");
        expect(url.searchParams.get("enemies")).toBeNull();
    });

    it("includes enemies + enemyRegion when present", () => {
        const path = scoutLinkPath({
            region: "kr",
            players: "s:Kiin#KR1,,,,",
            enemies: "s:Zeus#EUW,,,,",
            enemyRegion: "euw1"
        });
        const url = new URL(path, "https://x");
        expect(url.searchParams.get("enemies")).toBe("s:Zeus#EUW,,,,");
        expect(url.searchParams.get("enemyRegion")).toBe("euw1");
    });
});
