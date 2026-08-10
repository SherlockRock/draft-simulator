import { describe, it, expect } from "vitest";
import {
    NEW_GROUP_DRAFT_MODE,
    newGroupGridSettings,
    resolveNewGroupMetadata
} from "./groupCreation";
import { DEFAULT_GRID_COLS } from "./gridLayout";

describe("new-group creation defaults", () => {
    it("opens a new group at fearless", () => {
        // Decision 3 (2026-08-10). The NEW-group branch only — an existing
        // series with no stored draftMode still reads `standard` via
        // Canvas.tsx's toDraftMode fallback, which this constant never touches.
        expect(NEW_GROUP_DRAFT_MODE).toBe("fearless");
    });

    it("starts the grid form at DEFAULT_GRID_COLS with no labels", () => {
        expect(newGroupGridSettings()).toEqual({
            gridCols: DEFAULT_GRID_COLS,
            rowLabels: [],
            colLabels: []
        });
        expect(DEFAULT_GRID_COLS).toBe(3);
    });

    it("returns a fresh object each call so the form cannot alias it", () => {
        const a = newGroupGridSettings();
        a.colLabels.push("mutated");
        expect(newGroupGridSettings().colLabels).toEqual([]);
    });
});

describe("resolveNewGroupMetadata", () => {
    const base = {
        disabledChampions: [],
        draftMode: "fearless" as const,
        gameType: "scratch" as const,
        grid: newGroupGridSettings()
    };

    it("births a custom group as a grid at the dialog's columns (decision 13)", () => {
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            grid: { gridCols: 4, rowLabels: ["Week 1"], colLabels: ["A", "B"] }
        });
        expect(metadata.layout).toBe("grid");
        expect(metadata.gridCols).toBe(4);
        expect(metadata.rowLabels).toEqual(["Week 1"]);
        // mergeLabels pads to the column count and trims the trailing empties.
        expect(metadata.colLabels).toEqual(["A", "B"]);
    });

    it("gives a SERIES no grid keys at all", () => {
        // A series' interior is computed from its length (§5.1), not laid out
        // by a container grid. Writing `layout: grid` onto one would make the
        // grid paths treat its games as grid members.
        const metadata = resolveNewGroupMetadata({ ...base, isSeries: true });
        expect(metadata).not.toHaveProperty("layout");
        expect(metadata).not.toHaveProperty("gridCols");
        expect(metadata).not.toHaveProperty("rowLabels");
        expect(metadata).not.toHaveProperty("colLabels");
    });

    it("carries draft mode, disabled champions and classification either way", () => {
        for (const isSeries of [true, false]) {
            const metadata = resolveNewGroupMetadata({
                ...base,
                isSeries,
                draftMode: "ironman",
                disabledChampions: ["Yasuo"],
                gameType: "official"
            });
            expect(metadata.draftMode).toBe("ironman");
            expect(metadata.disabledChampions).toEqual(["Yasuo"]);
            expect(metadata.gameType).toBe("official");
        }
    });

    it("omits gameType entirely when the user picked Untagged", () => {
        // On a CREATE there is nothing stored to clear, so the D3 clear
        // protocol's `null` has no work to do — and `hasOwnProperty` is the
        // test, since a present key holding undefined still clobbers on a
        // shallow merge.
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            gameType: null
        });
        expect(Object.prototype.hasOwnProperty.call(metadata, "gameType")).toBe(false);
    });

    it("does not alias the caller's disabledChampions array", () => {
        const disabledChampions = ["Yasuo"];
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            disabledChampions
        });
        disabledChampions.push("Zed");
        expect(metadata.disabledChampions).toEqual(["Yasuo"]);
    });
});
