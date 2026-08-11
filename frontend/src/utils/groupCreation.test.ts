import { describe, it, expect } from "vitest";
import {
    NEW_GROUP_DRAFT_MODE,
    newGroupDimensions,
    newGroupGridSettings,
    resolveNewGroupMetadata
} from "./groupCreation";
import {
    DEFAULT_GRID_COLS,
    DEFAULT_GRID_ROWS,
    GRID_CELL_GAP,
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    gridDimensions
} from "./gridLayout";
import { gridContentHeightForRows } from "./gridRows";
import { cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

describe("new-group creation defaults", () => {
    it("opens a new series at fearless", () => {
        // Decision 3 (2026-08-10). The NEW-group branch only — an existing
        // series with no stored draftMode still reads `standard` via
        // Canvas.tsx's toDraftMode fallback, which this constant never touches.
        expect(NEW_GROUP_DRAFT_MODE).toBe("fearless");
    });

    it("starts the grid form at DEFAULT_GRID_COLS/ROWS with no labels", () => {
        expect(newGroupGridSettings()).toEqual({
            gridCols: DEFAULT_GRID_COLS,
            gridRows: DEFAULT_GRID_ROWS,
            rowLabels: [],
            colLabels: []
        });
        expect(DEFAULT_GRID_COLS).toBe(3);
        expect(DEFAULT_GRID_ROWS).toBe(1);
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

    it("births a custom group as a grid at the dialog's rows and columns", () => {
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            grid: {
                gridCols: 4,
                gridRows: 3,
                rowLabels: ["Week 1"],
                colLabels: ["A", "B"]
            }
        });
        expect(metadata.layout).toBe("grid");
        expect(metadata.gridCols).toBe(4);
        expect(metadata.gridRows).toBe(3);
        expect(metadata.rowLabels).toEqual(["Week 1"]);
        // mergeLabels pads to the column count and trims the trailing empties.
        expect(metadata.colLabels).toEqual(["A", "B"]);
    });

    /**
     * Draft mode WORKS on custom groups — `draftRestrictions` runs them
     * symmetrically and the backend gate reads the same key — so a default
     * leaking in would make every new group silently restrict champions across
     * its drafts. That is a real defect the first cut of 5c shipped.
     */
    it("gives a CUSTOM group no draftMode at all", () => {
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            draftMode: "fearless"
        });
        expect(Object.prototype.hasOwnProperty.call(metadata, "draftMode")).toBe(false);
    });

    it("still gives a SERIES its draft mode", () => {
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: true,
            draftMode: "fearless"
        });
        expect(metadata.draftMode).toBe("fearless");
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

    it("carries disabled champions and classification either way", () => {
        for (const isSeries of [true, false]) {
            const metadata = resolveNewGroupMetadata({
                ...base,
                isSeries,
                disabledChampions: ["Yasuo"],
                gameType: "official"
            });
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

    /**
     * The dialog reports "Grid layout off" as a NULL grid
     * (`GroupDisabledChampionsDialog`'s `save`), and a free group is what the
     * user asked for. Before this, the create path defaulted that null back to
     * `newGroupGridSettings()` and every new custom group was stamped
     * `layout: "grid"` — the toggle did nothing at all.
     */
    it("births a custom group as FREE when the dialog turned grid off", () => {
        const metadata = resolveNewGroupMetadata({
            ...base,
            isSeries: false,
            grid: null
        });
        expect(metadata.layout).toBe("free");
        for (const key of ["gridCols", "gridRows", "rowLabels", "colLabels"]) {
            expect(Object.prototype.hasOwnProperty.call(metadata, key)).toBe(false);
        }
    });

    it("gives a SERIES no layout key even when grid is off", () => {
        const metadata = resolveNewGroupMetadata({ ...base, isSeries: true, grid: null });
        expect(metadata).not.toHaveProperty("layout");
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

/**
 * A grid container is born at the size its configured grid needs. Before this,
 * every new Group got the server's flat 400x200 and only reached its real size
 * after the first drop resynced it.
 */
describe("newGroupDimensions", () => {
    const layout: CardLayout = "vertical";

    it("sizes a new grid to its configured rows and columns", () => {
        const grid = { gridCols: 4, gridRows: 3, rowLabels: [], colLabels: [] };
        const dims = newGroupDimensions({ isSeries: false, grid, layout });

        const height = gridContentHeightForRows([], 3, layout);
        expect(dims).toEqual({
            width: gridDimensions(height, 4, layout).width,
            height
        });
    });

    it("grows with each extra column and each extra row", () => {
        const at = (gridCols: number, gridRows: number) =>
            newGroupDimensions({
                isSeries: false,
                grid: { gridCols, gridRows, rowLabels: [], colLabels: [] },
                layout
            });

        const one = at(1, 1);
        expect(at(2, 1)?.width).toBeGreaterThan(one?.width ?? 0);
        expect(at(1, 2)?.height).toBeGreaterThan(one?.height ?? 0);
        // One more row is exactly one card plus one gap taller — the same step
        // the row model uses, not an invented one.
        expect((at(1, 2)?.height ?? 0) - (one?.height ?? 0)).toBe(
            cardHeight(layout) + GRID_CELL_GAP
        );
    });

    it("fits a single 1x1 cell exactly: header, padding, one card, padding", () => {
        const dims = newGroupDimensions({
            isSeries: false,
            grid: { gridCols: 1, gridRows: 1, rowLabels: [], colLabels: [] },
            layout
        });
        expect(dims?.height).toBe(
            GRID_HEADER_HEIGHT + 2 * GRID_PADDING + cardHeight(layout)
        );
    });

    it("declines to size a SERIES — its interior is computed from its length", () => {
        expect(
            newGroupDimensions({
                isSeries: true,
                grid: newGroupGridSettings(),
                layout
            })
        ).toBeNull();
    });

    it("declines to size a FREE group — the server's defaults describe it", () => {
        expect(newGroupDimensions({ isSeries: false, grid: null, layout })).toBeNull();
    });
});
