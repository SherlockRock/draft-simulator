import { describe, expect, it } from "vitest";
import type { CanvasGroup, ManagedTeamRow, Team, TeamListRow } from "./schemas";
import {
    archivedOwnedTeams,
    buildPickerTeams,
    pickerLabels,
    pickerRows,
    type PickerRow
} from "./teamPicker";

const listRow = (
    id: string,
    name: string,
    over: Partial<TeamListRow> = {}
): TeamListRow => ({
    id,
    owner_id: "me",
    name,
    region: "na1",
    tournament_id: null,
    Tournament: null,
    canEditRoster: true,
    ...over
});

const importedRow = (id: string, name: string, tournament: string): TeamListRow =>
    listRow(id, name, {
        owner_id: null,
        tournament_id: "t1",
        Tournament: { id: "t1", name: tournament, source: "esclub" },
        canEditRoster: false
    });

const payloadTeam = (id: string, name: string, over: Partial<Team> = {}): Team => ({
    id,
    owner_id: "mate",
    name,
    region: "na1",
    ...over
});

const group = (id: string, Team1?: Team, Team2?: Team): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: "series",
    positionX: 0,
    positionY: 0,
    metadata: {},
    ...(Team1 ? { Team1 } : {}),
    ...(Team2 ? { Team2 } : {})
});

const managed = (
    id: string,
    name: string,
    over: Partial<ManagedTeamRow> = {}
): ManagedTeamRow => ({
    ...listRow(id, name, { archived_at: "2026-11-01T00:00:00.000Z" }),
    useCounts: { official: 0, scrim: 0, scratch: 0, total: 0 },
    canArchive: true,
    canDelete: true,
    ...over
});

const kinds = (rows: PickerRow[]) => rows.map((r) => r.kind);

describe("buildPickerTeams", () => {
    it("offers a teammate's pickup linked on the canvas, read-only", () => {
        const mate = payloadTeam("mate-dog", "DOG");
        const result = buildPickerTeams([listRow("mine", "CAT")], [group("g1", mate)]);
        expect(result.map((t) => t.id)).toEqual(["mine", "mate-dog"]);
        expect(result[1].canEditRoster).toBe(false);
        expect(result[1].name).toBe("DOG");
    });

    it("lets the list row win over the payload row for the same id", () => {
        const result = buildPickerTeams(
            [listRow("a", "Mine")],
            [group("g1", payloadTeam("a", "Mine"), payloadTeam("a", "Mine"))]
        );
        expect(result).toHaveLength(1);
        expect(result[0].canEditRoster).toBe(true);
    });

    it("dedupes an imported team in the list and on the canvas", () => {
        const result = buildPickerTeams(
            [importedRow("i1", "DOG", "League 2")],
            [
                group("g1", payloadTeam("i1", "DOG")),
                group("g2", undefined, payloadTeam("i1", "DOG"))
            ]
        );
        expect(result).toHaveLength(1);
        expect(pickerLabels(result).get("i1")).toBe("DOG · League 2");
    });

    it("reads only the groups passed in", () => {
        expect(buildPickerTeams([], [])).toEqual([]);
        expect(buildPickerTeams([listRow("a", "A")], [group("g1")])).toHaveLength(1);
    });

    it("keeps a payload-only team's tournament", () => {
        const result = buildPickerTeams(
            [],
            [
                group(
                    "g1",
                    payloadTeam("i2", "DOG", {
                        Tournament: { id: "t", name: "League 2", source: "esclub" }
                    })
                )
            ]
        );
        expect(pickerLabels(result).get("i2")).toBe("DOG · League 2");
    });
});

describe("pickerLabels", () => {
    it("always suffixes a tournament team, plain for pickup", () => {
        const labels = pickerLabels([listRow("p", "DOG"), importedRow("i", "CAT", "L1")]);
        expect(labels.get("p")).toBe("DOG");
        expect(labels.get("i")).toBe("CAT · L1");
    });

    it("numbers two pickup DOGs, first keeps its label, stable by id", () => {
        const a = pickerLabels([listRow("b", "DOG"), listRow("a", "dog")]);
        expect(a.get("a")).toBe("dog");
        expect(a.get("b")).toBe("DOG · 2");
        const b = pickerLabels([listRow("a", "dog"), listRow("b", "DOG")]);
        expect(b).toEqual(a);
    });

    it("numbers three and keeps every label unique", () => {
        const labels = pickerLabels([
            listRow("1", "DOG"),
            listRow("2", "DOG"),
            listRow("3", "DOG"),
            importedRow("4", "DOG", "L")
        ]);
        expect([...labels.values()].sort()).toEqual([
            "DOG",
            "DOG · 2",
            "DOG · 3",
            "DOG · L"
        ]);
        expect(new Set(labels.values()).size).toBe(4);
    });

    it("stays unique when a team is literally named like a generated label", () => {
        const labels = pickerLabels([
            listRow("1", "DOG"),
            listRow("2", "DOG"),
            listRow("3", "DOG · 2")
        ]);
        const values = [...labels.values()].map((label) => label.toLowerCase());
        expect(new Set(values).size).toBe(3);
    });

    it("stays unique when a pickup team is named like a league team's label", () => {
        const labels = pickerLabels([
            importedRow("1", "DOG", "League 2"),
            listRow("2", "DOG · League 2")
        ]);
        const values = [...labels.values()].map((label) => label.toLowerCase());
        expect(new Set(values).size).toBe(2);
    });
});

describe("pickerRows", () => {
    it("offers a collaborator's payload-only team and it does not block Create", () => {
        const teams = buildPickerTeams([], [group("g1", payloadTeam("m", "DOG"))]);
        const rows = pickerRows("DOG", teams, { archivedOwned: [] });
        expect(rows).toEqual([
            { kind: "team", team: teams[0], label: "DOG" },
            { kind: "create", name: "DOG" }
        ]);
        expect(teams[0].canEditRoster).toBe(false);
    });

    it("matches by substring, case-insensitively, labelled", () => {
        const teams = [listRow("a", "Dogs"), listRow("b", "Cats")];
        const rows = pickerRows("do", teams, { archivedOwned: [] });
        expect(rows.map((r) => (r.kind === "team" ? r.label : r.kind))).toEqual([
            "Dogs",
            "create"
        ]);
    });

    it("offers restore AND create for an archived owned name typed in full", () => {
        const arch = managed("old", "DOG");
        const rows = pickerRows("  dog ", [listRow("x", "CAT")], {
            archivedOwned: [arch]
        });
        expect(kinds(rows)).toEqual(["restore", "create"]);
        const restore = rows[0];
        if (restore.kind !== "restore") throw new Error("expected restore");
        expect(restore.team.id).toBe("old");
        expect(restore.label).toBe("DOG");
        expect(rows[1]).toEqual({ kind: "create", name: "dog" });
    });

    it("offers no restore row for a partial name", () => {
        const rows = pickerRows("do", [], { archivedOwned: [managed("old", "DOG")] });
        expect(kinds(rows)).toEqual(["create"]);
    });

    it("orders teams, restore, create", () => {
        const rows = pickerRows("DOG", [listRow("a", "DOGE")], {
            archivedOwned: [managed("old", "DOG")]
        });
        expect(kinds(rows)).toEqual(["team", "restore", "create"]);
    });

    it("offers no create row for a placeholder", () => {
        expect(pickerRows("Team 1", [], { archivedOwned: [] })).toEqual([]);
        expect(pickerRows(" team 2 ", [], { archivedOwned: [] })).toEqual([]);
    });

    it("offers no create row for an empty query", () => {
        expect(pickerRows("  ", [], { archivedOwned: [] })).toEqual([]);
    });

    it("offers no create row when an active owned team has the name", () => {
        const rows = pickerRows("dog", [listRow("a", "DOG")], { archivedOwned: [] });
        expect(kinds(rows)).toEqual(["team"]);
    });

    it("an archived editable row in the list does not block create (Q4)", () => {
        const rows = pickerRows(
            "DOG",
            [listRow("a", "DOG", { archived_at: "2026-11-01T00:00:00.000Z" })],
            { archivedOwned: [] }
        );
        expect(kinds(rows)).toEqual(["team", "create"]);
    });

    it("an imported same-named team does not block create", () => {
        const rows = pickerRows("DOG", [importedRow("i", "DOG", "L")], {
            archivedOwned: []
        });
        expect(kinds(rows)).toEqual(["team", "create"]);
    });

    it("labels same-named teams apart in the rows", () => {
        const rows = pickerRows("DOG", [listRow("a", "DOG"), listRow("b", "DOG")], {
            archivedOwned: []
        });
        expect(rows.flatMap((r) => (r.kind === "team" ? [r.label] : []))).toEqual([
            "DOG",
            "DOG · 2"
        ]);
    });
});

describe("archivedOwnedTeams", () => {
    it("keeps archived pickup teams the user can restore", () => {
        const rows = [
            managed("a", "A"),
            managed("active", "B", { archived_at: null }),
            managed("t", "C", {
                tournament_id: "t1",
                Tournament: { id: "t1", name: "L", source: "esclub" }
            }),
            managed("cant", "D", { canArchive: false })
        ];
        expect(archivedOwnedTeams(rows).map((t) => t.id)).toEqual(["a"]);
    });
});
