import { describe, expect, it } from "vitest";
import type { Team, TeamPlayer } from "@draft-sim/shared-types";
import {
    MAX_ROSTER,
    mergeScoutedRoster,
    resolveWriteBackTeam,
    shouldStayArmed
} from "./rosterWriteBack";
import type { PlayerId } from "./playerStats";

const player = (
    gameName: string,
    ordinal: number,
    role: TeamPlayer["role"] = null
): TeamPlayer => ({
    id: `id-${gameName}-${ordinal}`,
    team_id: "team-1",
    role,
    gameName,
    tagLine: "NA1",
    ordinal
});

const pid = (gameName: string): PlayerId => ({ gameName, tagLine: "NA1" });

const aTeam = (overrides: Partial<Team> = {}): Team => ({
    id: "team-1",
    owner_id: "user-1",
    name: "MEOW",
    region: "na1",
    TeamPlayers: [],
    ...overrides
});

describe("mergeScoutedRoster", () => {
    it("keeps bench players that were never scouted", () => {
        const existing = [
            player("Alice", 0, "top"),
            player("Bob", 1, "jungle"),
            player("Carl", 2, "mid"),
            player("Dana", 3, "adc"),
            player("Erin", 4, "support"),
            player("Fred", 5),
            player("Gina", 6),
            player("Hugo", 7)
        ];
        const slots = [pid("Dana"), pid("Bob"), pid("Alice"), pid("Carl"), pid("Erin")];

        expect(mergeScoutedRoster(existing, slots)).toEqual({
            ok: true,
            players: [
                { role: "top", gameName: "Dana", tagLine: "NA1" },
                { role: "jungle", gameName: "Bob", tagLine: "NA1" },
                { role: "mid", gameName: "Alice", tagLine: "NA1" },
                { role: "adc", gameName: "Carl", tagLine: "NA1" },
                { role: "support", gameName: "Erin", tagLine: "NA1" },
                { role: null, gameName: "Fred", tagLine: "NA1" },
                { role: null, gameName: "Gina", tagLine: "NA1" },
                { role: null, gameName: "Hugo", tagLine: "NA1" }
            ]
        });
    });

    it("demotes a dropped slot-holder to the bench instead of deleting them", () => {
        const existing = [player("Alice", 0, "top"), player("Bob", 1, "jungle")];

        expect(
            mergeScoutedRoster(existing, [pid("Bob"), null, null, null, null])
        ).toEqual({
            ok: true,
            players: [
                { role: "top", gameName: "Bob", tagLine: "NA1" },
                { role: null, gameName: "Alice", tagLine: "NA1" }
            ]
        });
    });

    it("appends scouted players who are not on the roster", () => {
        const existing = [player("Alice", 0, "top")];

        expect(
            mergeScoutedRoster(existing, [pid("Alice"), pid("Zed"), null, null, null])
        ).toEqual({
            ok: true,
            players: [
                { role: "top", gameName: "Alice", tagLine: "NA1" },
                { role: "jungle", gameName: "Zed", tagLine: "NA1" }
            ]
        });
    });

    it("matches case-insensitively and keeps the stored spelling", () => {
        const existing = [player("AliCe", 0, "top")];
        const slots = [{ gameName: "alice", tagLine: "na1" }, null, null, null, null];

        expect(mergeScoutedRoster(existing, slots)).toEqual({
            ok: true,
            players: [{ role: "top", gameName: "AliCe", tagLine: "NA1" }]
        });
    });

    // Regression: nothing stops a roster holding two identical rows — there is
    // no unique constraint and TeamRosterEditor's paste accepts "A#1,A#1". A
    // bench pass that deduped against itself would silently delete one.
    it("preserves duplicate bench rows", () => {
        const existing = [player("Alice", 0), player("Alice", 1)];

        expect(mergeScoutedRoster(existing, [null, null, null, null, null])).toEqual({
            ok: true,
            players: [
                { role: null, gameName: "Alice", tagLine: "NA1" },
                { role: null, gameName: "Alice", tagLine: "NA1" }
            ]
        });
    });

    it("collapses a duplicate only where it is promoted into a slot", () => {
        const existing = [player("Alice", 0), player("Alice", 1)];

        expect(
            mergeScoutedRoster(existing, [pid("Alice"), null, null, null, null])
        ).toEqual({
            ok: true,
            players: [{ role: "top", gameName: "Alice", tagLine: "NA1" }]
        });
    });

    it("promotes a sub and benches the displaced starter, in URL order", () => {
        const existing = [
            player("Alice", 0, "top"),
            player("Bob", 1, "jungle"),
            player("Carl", 2, "mid"),
            player("Dana", 3, "adc"),
            player("Erin", 4, "support"),
            player("Fred", 5),
            player("Gina", 6)
        ];
        const slots = [pid("Alice"), pid("Bob"), pid("Fred"), pid("Dana"), pid("Erin")];

        expect(mergeScoutedRoster(existing, slots, [pid("Carl"), pid("Gina")])).toEqual({
            ok: true,
            players: [
                { role: "top", gameName: "Alice", tagLine: "NA1" },
                { role: "jungle", gameName: "Bob", tagLine: "NA1" },
                { role: "mid", gameName: "Fred", tagLine: "NA1" },
                { role: "adc", gameName: "Dana", tagLine: "NA1" },
                { role: "support", gameName: "Erin", tagLine: "NA1" },
                { role: null, gameName: "Carl", tagLine: "NA1" },
                { role: null, gameName: "Gina", tagLine: "NA1" }
            ]
        });
    });

    // The most important test in the slice. "s:a,b,c,d,e" means both "legacy
    // link, bench unknown" and "bench-aware, bench deliberately empty"; under
    // union that ambiguity is harmless, because an absent bench just means the
    // stored players come back. Authoritative-bench semantics would delete
    // every sub added since a link was bookmarked.
    it("cannot delete the stored bench when the link carries none", () => {
        const existing = [
            player("Alice", 0, "top"),
            player("Bob", 1, "jungle"),
            player("Carl", 2, "mid"),
            player("Dana", 3, "adc"),
            player("Erin", 4, "support"),
            player("Fred", 5),
            player("Gina", 6)
        ];
        const slots = [pid("Alice"), pid("Bob"), pid("Carl"), pid("Dana"), pid("Erin")];

        const merged = mergeScoutedRoster(existing, slots, []);
        expect(merged).toEqual({
            ok: true,
            players: [
                { role: "top", gameName: "Alice", tagLine: "NA1" },
                { role: "jungle", gameName: "Bob", tagLine: "NA1" },
                { role: "mid", gameName: "Carl", tagLine: "NA1" },
                { role: "adc", gameName: "Dana", tagLine: "NA1" },
                { role: "support", gameName: "Erin", tagLine: "NA1" },
                { role: null, gameName: "Fred", tagLine: "NA1" },
                { role: null, gameName: "Gina", tagLine: "NA1" }
            ]
        });
    });

    // Decision 43: reconciliation is BY COUNT, not by set membership. A URL
    // bench that under-represents a duplicate must not delete the extra row.
    it("reconciles duplicates by count rather than by identity", () => {
        const existing = [player("Alice", 0), player("Alice", 1)];

        expect(
            mergeScoutedRoster(existing, [null, null, null, null, null], [pid("Alice")])
        ).toEqual({
            ok: true,
            players: [
                { role: null, gameName: "Alice", tagLine: "NA1" },
                { role: null, gameName: "Alice", tagLine: "NA1" }
            ]
        });
    });

    it("refuses to save when the merge would exceed the roster cap", () => {
        const existing = Array.from({ length: 8 }, (_, i) => player(`P${i}`, i));
        const slots = [pid("New1"), pid("New2"), pid("New3"), null, null];

        expect(mergeScoutedRoster(existing, slots)).toEqual({
            ok: false,
            reason: "over-cap",
            count: 11
        });
        expect(MAX_ROSTER).toBe(10);
    });

    // Union can exceed ten even when neither side does on its own, so the
    // over-cap refusal stays reachable with a bench in play.
    it("still refuses over-cap when the URL bench barely overlaps the roster", () => {
        const existing = Array.from({ length: 10 }, (_, i) => player(`P${i}`, i));
        const slots = [pid("P0"), pid("X1"), pid("X2"), pid("X3"), pid("X4")];
        const urlBench = [pid("X5"), pid("X6"), pid("X7"), pid("X8"), pid("X9")];

        expect(mergeScoutedRoster(existing, slots, urlBench)).toEqual({
            ok: false,
            reason: "over-cap",
            count: 19
        });
    });

    it("emits nothing for empty slots and an empty roster", () => {
        expect(mergeScoutedRoster([], [null, null, null, null, null])).toEqual({
            ok: true,
            players: []
        });
    });
});

describe("resolveWriteBackTeam", () => {
    it("returns the matching team", () => {
        const mine = aTeam();
        expect(resolveWriteBackTeam("team-1", [mine])).toBe(mine);
    });

    it("returns null for an unknown or empty id", () => {
        expect(resolveWriteBackTeam("team-9", [aTeam()])).toBeNull();
        expect(resolveWriteBackTeam("", [aTeam()])).toBeNull();
    });
});

describe("shouldStayArmed", () => {
    const roster = [player("Alice", 0, "top"), player("Bob", 1, "jungle")];

    it("stays armed when the lineup still overlaps the roster", () => {
        // Appending a sub must NOT disarm — decision 27 supports it.
        expect(shouldStayArmed(roster, [pid("Alice"), pid("Zed")])).toBe(true);
    });

    it("stays armed on a case-only difference", () => {
        expect(shouldStayArmed(roster, [{ gameName: "alice", tagLine: "na1" }])).toBe(
            true
        );
    });

    it("disarms when no submitted player belongs to the roster", () => {
        expect(shouldStayArmed(roster, [pid("Zed"), pid("Yorick")])).toBe(false);
    });

    it("disarms on an empty lineup", () => {
        expect(shouldStayArmed(roster, [])).toBe(false);
    });
});
