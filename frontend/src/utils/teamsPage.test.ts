import { describe, it, expect } from "vitest";
import type {
    ManagedTeamRow,
    ManagedTournament,
    TeamPlayer,
    TeamsManageResponse,
    TeamUseCounts
} from "@draft-sim/shared-types";
import {
    PAGE_INTRO,
    buildTeamsPageGroups,
    deleteConfirmText,
    emptySelection,
    playersLabel,
    pruneSelection,
    selectableIds,
    selectionSummary,
    toggleGroupSelected,
    toggleSelected,
    useCountLabel
} from "./teamsPage";

const counts = (official = 0, scrim = 0, scratch = 0): TeamUseCounts => ({
    official,
    scrim,
    scratch,
    total: official + scrim + scratch
});

const player = (teamId: string, n: number): TeamPlayer[] => [
    {
        id: `${teamId}-p${n}`,
        team_id: teamId,
        role: null,
        gameName: `P${n}`,
        tagLine: "NA1",
        ordinal: n
    }
];

function team(
    id: string,
    name: string,
    over: Partial<ManagedTeamRow> = {}
): ManagedTeamRow {
    return {
        id,
        owner_id: "me",
        name,
        region: "na1",
        tournament_id: null,
        source: "manual",
        archived_at: null,
        Tournament: null,
        canEditRoster: true,
        TeamPlayers: [],
        useCounts: counts(),
        canArchive: true,
        canDelete: true,
        ...over
    };
}

function imported(
    id: string,
    name: string,
    tournamentId: string,
    over: Partial<ManagedTeamRow> = {}
): ManagedTeamRow {
    return team(id, name, {
        owner_id: null,
        source: "esclub",
        tournament_id: tournamentId,
        Tournament: { id: tournamentId, name: "x", source: "esclub" },
        canEditRoster: false,
        canArchive: false,
        canDelete: false,
        ...over
    });
}

const tournaments: ManagedTournament[] = [
    {
        id: "tB",
        name: "beta League",
        source: "esclub",
        region: "eu",
        archived_at: null
    },
    {
        id: "tA",
        name: "Alpha League",
        source: "esclub",
        region: "na1",
        archived_at: null
    },
    {
        id: "tEmpty",
        name: "Empty Cup",
        source: "esclub",
        region: "na1",
        archived_at: null
    },
    {
        id: "tOld",
        name: "Old League",
        source: "esclub",
        region: "na1",
        archived_at: "2026-10-01T00:00:00.000Z"
    }
];

const data: TeamsManageResponse = {
    tournaments,
    teams: [
        imported("a2", "Zed", "tA", { TeamPlayers: player("a2", 1) }),
        imported("a1", "apex", "tA", {
            TeamPlayers: [...player("a1", 1), ...player("a1", 2)]
        }),
        imported("b1", "Bees", "tB"),
        imported("o1", "Oldies", "tOld"),
        team("p2", "Wolves", { useCounts: counts(4, 12, 1) }),
        team("p1", "cats"),
        team("x1", "Archived Cats", {
            archived_at: "2026-10-02T00:00:00.000Z",
            useCounts: counts(0, 2, 0)
        }),
        team("x2", "Archived Bats", {
            archived_at: "2026-10-03T00:00:00.000Z"
        }),
        // owned manual-tournament team: tournament not in data.tournaments
        team("m1", "Manual", {
            tournament_id: "tM",
            Tournament: { id: "tM", name: "Manual Open", source: "manual" },
            canArchive: false,
            canDelete: false
        })
    ]
};

describe("buildTeamsPageGroups", () => {
    const groups = buildTeamsPageGroups(data);

    it("orders active leagues by name (case-insensitive), then pickup, then archived", () => {
        expect(groups.map((g) => g.kind)).toEqual([
            "tournament",
            "tournament",
            "tournament",
            "tournament",
            "pickup",
            "archived"
        ]);
        const names = groups.flatMap((g) => (g.kind === "tournament" ? [g.name] : []));
        expect(names).toEqual([
            "Alpha League",
            "beta League",
            "Empty Cup",
            "Manual Open"
        ]);
    });

    it("sorts teams by name within a group, ignoring case", () => {
        const alpha = groups[0];
        expect(alpha.kind).toBe("tournament");
        if (alpha.kind === "tournament") {
            expect(alpha.teams.map((t) => t.name)).toEqual(["apex", "Zed"]);
            expect(alpha.id).toBe("tA");
            expect(alpha.region).toBe("na1");
            expect(alpha.source).toBe("esclub");
        }
    });

    it("keeps an active league with no teams as a group", () => {
        const empty = groups.find((g) => g.kind === "tournament" && g.id === "tEmpty");
        expect(empty).toBeDefined();
        if (empty && empty.kind === "tournament") {
            expect(empty.teams).toEqual([]);
        }
    });

    it("builds a group from Tournament for a team whose tournament is not listed", () => {
        const manual = groups.find((g) => g.kind === "tournament" && g.id === "tM");
        expect(manual).toBeDefined();
        if (manual && manual.kind === "tournament") {
            expect(manual.name).toBe("Manual Open");
            expect(manual.source).toBe("manual");
            expect(manual.teams.map((t) => t.id)).toEqual(["m1"]);
        }
    });

    it("puts active pickup teams (no tournament, not archived) in the pickup group", () => {
        const pickup = groups.find((g) => g.kind === "pickup");
        expect(pickup?.kind).toBe("pickup");
        if (pickup && pickup.kind === "pickup") {
            expect(pickup.teams.map((t) => t.name)).toEqual(["cats", "Wolves"]);
        }
    });

    it("puts archived leagues with their teams, and archived pickup teams, in one archived group", () => {
        const archived = groups[groups.length - 1];
        expect(archived.kind).toBe("archived");
        if (archived.kind === "archived") {
            expect(archived.tournaments.map((t) => t.id)).toEqual(["tOld"]);
            expect(archived.tournaments[0].teams.map((t) => t.id)).toEqual(["o1"]);
            expect(archived.pickupTeams.map((t) => t.name)).toEqual([
                "Archived Bats",
                "Archived Cats"
            ]);
        }
    });

    it("always has a pickup group, even when empty, and omits archived when empty", () => {
        const result = buildTeamsPageGroups({ tournaments: [], teams: [] });
        expect(result).toEqual([{ kind: "pickup", teams: [] }]);
    });

    it("emits the archived group for an archived pickup team alone", () => {
        const result = buildTeamsPageGroups({
            tournaments: [],
            teams: [team("x", "Gone", { archived_at: "2026-10-02T00:00:00Z" })]
        });
        expect(result.map((g) => g.kind)).toEqual(["pickup", "archived"]);
        const a = result[1];
        expect(a.kind).toBe("archived");
        if (a.kind === "archived") {
            expect(a.tournaments).toEqual([]);
            expect(a.pickupTeams.map((t) => t.id)).toEqual(["x"]);
        }
    });

    it("keeps an archived league with no teams in the archived group", () => {
        const result = buildTeamsPageGroups({
            tournaments: [tournaments[3]],
            teams: []
        });
        expect(result.map((g) => g.kind)).toEqual(["pickup", "archived"]);
    });
});

describe("row text", () => {
    it("useCountLabel always shows official and scrim, never scratch", () => {
        expect(useCountLabel(counts(4, 12, 1))).toBe("4 official · 12 scrim");
        expect(useCountLabel(counts())).toBe("0 official · 0 scrim");
        expect(useCountLabel(counts(0, 0, 9))).toBe("0 official · 0 scrim");
    });

    it("playersLabel handles none, one and many", () => {
        expect(playersLabel(team("a", "A"))).toBe("No players");
        expect(playersLabel(team("a", "A", { TeamPlayers: player("a", 1) }))).toBe(
            "1 player"
        );
        expect(
            playersLabel(
                team("a", "A", {
                    TeamPlayers: [
                        ...player("a", 1),
                        ...player("a", 2),
                        ...player("a", 3),
                        ...player("a", 4),
                        ...player("a", 5)
                    ]
                })
            )
        ).toBe("5 players");
    });
});

describe("selection", () => {
    const find = (kind: "pickup" | "archived") => {
        const g = buildTeamsPageGroups(data).find((x) => x.kind === kind);
        if (!g) throw new Error("group missing");
        return g;
    };

    it("selectableIds returns only rows that can be archived or deleted", () => {
        expect(selectableIds(find("pickup")).sort()).toEqual(["p1", "p2"]);
        expect(selectableIds(find("archived")).sort()).toEqual(["x1", "x2"]);
        const alpha = buildTeamsPageGroups(data)[0];
        expect(selectableIds(alpha)).toEqual([]);
    });

    it("selectableIds includes a row that can only be deleted", () => {
        const g = {
            kind: "pickup" as const,
            teams: [
                team("d", "D", { canArchive: false, canDelete: true }),
                team("n", "N", { canArchive: false, canDelete: false })
            ]
        };
        expect(selectableIds(g)).toEqual(["d"]);
    });

    it("toggleSelected adds and removes without mutating", () => {
        const s0 = emptySelection();
        const s1 = toggleSelected(s0, "p1", "active");
        expect(s0.ids.size).toBe(0);
        expect([...s1.ids]).toEqual(["p1"]);
        expect(s1.scope).toBe("active");
        const s2 = toggleSelected(s1, "p2", "active");
        expect([...s2.ids].sort()).toEqual(["p1", "p2"]);
        const s3 = toggleSelected(s2, "p1", "active");
        expect([...s3.ids]).toEqual(["p2"]);
        expect([...s2.ids].sort()).toEqual(["p1", "p2"]);
    });

    it("selecting from the other scope replaces the selection", () => {
        const s1 = toggleSelected(emptySelection(), "p1", "active");
        const s2 = toggleSelected(s1, "x1", "archived");
        expect(s2.scope).toBe("archived");
        expect([...s2.ids]).toEqual(["x1"]);
    });

    it("toggleGroupSelected selects all when not all are selected, else clears them", () => {
        const s1 = toggleSelected(emptySelection(), "p1", "active");
        const s2 = toggleGroupSelected(s1, ["p1", "p2"], "active");
        expect([...s2.ids].sort()).toEqual(["p1", "p2"]);
        const s3 = toggleGroupSelected(s2, ["p1", "p2"], "active");
        expect(s3.ids.size).toBe(0);
    });

    it("toggleGroupSelected from the other scope replaces the selection", () => {
        const s1 = toggleSelected(emptySelection(), "p1", "active");
        const s2 = toggleGroupSelected(s1, ["x1", "x2"], "archived");
        expect(s2.scope).toBe("archived");
        expect([...s2.ids].sort()).toEqual(["x1", "x2"]);
    });

    it("toggleGroupSelected with no ids leaves the selection empty", () => {
        const s = toggleGroupSelected(emptySelection(), [], "active");
        expect(s.ids.size).toBe(0);
    });

    it("pruneSelection drops ids that vanished or changed scope, keeps the rest", () => {
        const sel = toggleGroupSelected(emptySelection(), ["p1", "p2", "gone"], "active");
        const after: TeamsManageResponse = {
            tournaments: [],
            teams: [
                team("p1", "cats"),
                // p2 was archived since
                team("p2", "Wolves", { archived_at: "2026-11-01T00:00:00Z" })
            ]
        };
        const pruned = pruneSelection(sel, after);
        expect([...pruned.ids]).toEqual(["p1"]);
        expect(pruned.scope).toBe("active");
        expect(pruneSelection(sel, { tournaments: [], teams: [] }).ids.size).toBe(0);
    });

    it("pruneSelection keeps the archived scope's archived rows", () => {
        const sel = toggleSelected(emptySelection(), "x1", "archived");
        expect([...pruneSelection(sel, data).ids]).toEqual(["x1"]);
    });

    it("pruneSelection drops a row that now has a tournament_id even if canArchive is true", () => {
        const sel = toggleSelected(emptySelection(), "p1", "active");
        const after: TeamsManageResponse = {
            tournaments: [],
            teams: [team("p1", "cats", { tournament_id: "tX" })]
        };
        expect(pruneSelection(sel, after).ids.size).toBe(0);
    });

    it("selectableIds never offers a tournament row, even with canArchive true", () => {
        const g = {
            kind: "tournament" as const,
            id: "tX",
            name: "X",
            region: "na1",
            source: "esclub",
            teams: [imported("i", "I", "tX", { canArchive: true, canDelete: true })]
        };
        expect(selectableIds(g)).toEqual([]);
    });

    it("pruneSelection drops rows that are no longer selectable", () => {
        const sel = toggleSelected(emptySelection(), "p1", "active");
        const after: TeamsManageResponse = {
            tournaments: [],
            teams: [team("p1", "cats", { canArchive: false, canDelete: false })]
        };
        expect(pruneSelection(sel, after).ids.size).toBe(0);
    });
});

describe("selectionSummary", () => {
    const pickupRows = [
        team("p2", "Wolves", { useCounts: counts(4, 12, 1) }),
        team("p1", "cats", { useCounts: counts(1, 0, 0) })
    ];

    it("sums uses and allows archive and delete in active scope", () => {
        const sel = toggleGroupSelected(emptySelection(), ["p1", "p2"], "active");
        expect(selectionSummary(sel, pickupRows)).toEqual({
            count: 2,
            uses: { official: 5, scrim: 12, scratch: 1, total: 18 },
            canArchive: true,
            canRestore: false,
            canDelete: true
        });
    });

    it("allows restore and delete, not archive, in archived scope", () => {
        const rows = [team("x1", "A"), team("x2", "B")];
        const sel = toggleGroupSelected(emptySelection(), ["x1", "x2"], "archived");
        const s = selectionSummary(sel, rows);
        expect(s.canArchive).toBe(false);
        expect(s.canRestore).toBe(true);
        expect(s.canDelete).toBe(true);
    });

    it("counts only selected rows", () => {
        const sel = toggleSelected(emptySelection(), "p1", "active");
        const s = selectionSummary(sel, pickupRows);
        expect(s.count).toBe(1);
        expect(s.uses.total).toBe(1);
    });

    it("canRestore needs every archived row to be archivable", () => {
        const rows = [team("x1", "A", { canArchive: false, canDelete: true })];
        const sel = toggleSelected(emptySelection(), "x1", "archived");
        const s = selectionSummary(sel, rows);
        expect(s.canRestore).toBe(false);
        expect(s.canDelete).toBe(true);
    });

    it("an empty selection can do nothing", () => {
        expect(selectionSummary(emptySelection(), pickupRows)).toEqual({
            count: 0,
            uses: counts(),
            canArchive: false,
            canRestore: false,
            canDelete: false
        });
    });

    it("requires every row to be archivable or deletable", () => {
        const rows = [
            team("a", "A", { canArchive: true, canDelete: false }),
            team("b", "B", { canArchive: false, canDelete: true })
        ];
        const sel = toggleGroupSelected(emptySelection(), ["a", "b"], "active");
        const s = selectionSummary(sel, rows);
        expect(s.canArchive).toBe(false);
        expect(s.canDelete).toBe(false);
        const only = toggleSelected(emptySelection(), "a", "active");
        const s2 = selectionSummary(only, rows);
        expect(s2.canArchive).toBe(true);
        expect(s2.canDelete).toBe(false);
    });
});

describe("strings", () => {
    it("PAGE_INTRO is the D10 intro", () => {
        expect(PAGE_INTRO).toBe(
            "Your pickup teams and the teams of leagues you've added. Imported teams come from the league and can't be edited. Archiving hides a team or league from your pickers; it stays linked wherever it's used."
        );
    });

    it("one team with uses lists the non-zero parts", () => {
        expect(
            deleteConfirmText([team("d", "DOG", { useCounts: counts(4, 12, 1) })])
        ).toBe(
            "Delete DOG? It's linked to 17 series on your canvases (4 official, 12 scrim, 1 scratch). Those series keep its name as plain text. This can't be undone."
        );
    });

    it("omits zero parts", () => {
        expect(
            deleteConfirmText([team("d", "DOG", { useCounts: counts(0, 3, 0) })])
        ).toBe(
            "Delete DOG? It's linked to 3 series on your canvases (3 scrim). Those series keep its name as plain text. This can't be undone."
        );
        expect(
            deleteConfirmText([team("d", "DOG", { useCounts: counts(2, 0, 1) })])
        ).toBe(
            "Delete DOG? It's linked to 3 series on your canvases (2 official, 1 scratch). Those series keep its name as plain text. This can't be undone."
        );
    });

    it("one series is still 'series'", () => {
        expect(
            deleteConfirmText([team("d", "DOG", { useCounts: counts(0, 0, 1) })])
        ).toBe(
            "Delete DOG? It's linked to 1 series on your canvases (1 scratch). Those series keep its name as plain text. This can't be undone."
        );
    });

    it("omits the parentheses when the total is above 0 but every part is 0", () => {
        expect(
            deleteConfirmText([
                team("d", "DOG", {
                    useCounts: { official: 0, scrim: 0, scratch: 0, total: 2 }
                })
            ])
        ).toBe(
            "Delete DOG? It's linked to 2 series on your canvases. Those series keep its name as plain text. This can't be undone."
        );
    });

    it("one team with no uses", () => {
        expect(deleteConfirmText([team("d", "DOG")])).toBe(
            "Delete DOG? It isn't linked to any series on your canvases. This can't be undone."
        );
    });

    it("several teams sum the counts", () => {
        expect(
            deleteConfirmText([
                team("a", "A", { useCounts: counts(4, 10, 0) }),
                team("b", "B", { useCounts: counts(0, 2, 1) }),
                team("c", "C")
            ])
        ).toBe(
            "Delete 3 teams? They're linked to 17 series on your canvases (4 official, 12 scrim, 1 scratch). Those series keep their names as plain text. This can't be undone."
        );
    });

    it("several teams with no uses", () => {
        expect(deleteConfirmText([team("a", "A"), team("b", "B"), team("c", "C")])).toBe(
            "Delete 3 teams? They aren't linked to any series on your canvases. This can't be undone."
        );
    });
});
