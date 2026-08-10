import { describe, it, expect } from "vitest";
import {
    GRID_CELL_GAP,
    GRID_PADDING,
    GRID_HEADER_HEIGHT,
    CARD_FOOTPRINT,
    cellToPosition,
    positionToCell,
    firstEmptyRect,
    nearestFreeRect,
    rowCells,
    resolveGridDrop,
    reflowAfterGrowth,
    arrangeGrid,
    gridDimensions,
    rowCountAfter,
    colsFromWidth,
    effectiveGridCols,
    mergeLabels,
    buildGridMetadata,
    arrangedRowCount,
    resolveGridSave,
    toPositionUpdates,
    manualFloorOf,
    resolveContainerDims,
    resolveGridDims,
    contentBoundsOf,
    footprintPixelWidth,
    MIN_GROUP_WIDTH,
    MIN_GROUP_HEIGHT,
    DEFAULT_GROUP_WIDTH,
    DEFAULT_GROUP_HEIGHT,
    materializeGrid,
    rowsOfItems,
    type GridAssignment,
    type GridCell,
    type GridFootprint,
    type GridItem
} from "./gridLayout";
import { memberY, rowsOfIndexed } from "./gridRows";
import {
    GROUP_BORDER_WIDTH,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
    cardWidth,
    getSeriesGroupDimensions
} from "./helpers";
import type { CardLayout } from "./canvasCardLayout";
import type { CanvasGroup } from "./schemas";

const LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

/**
 * A fixture's CHROME: what `canvasTree.insetOf` and `nodeSize` would report.
 * Everything defaults to a Card, so every pre-§6.0a fixture keeps the exact
 * lattice positions it had — an all-equal-inset row materializes to the uniform
 * lattice, which is the property entry condition 5 turns on.
 */
type Chrome = { inset: number; height: number };
const CARD_INSET = GROUP_BORDER_WIDTH;
const cardChrome = (layout: CardLayout): Chrome => ({
    inset: CARD_INSET,
    height: cardHeight(layout)
});
const SERIES_INSET =
    GROUP_BORDER_WIDTH +
    SERIES_HEADER_HEIGHT +
    SERIES_PADDING_Y +
    SERIES_GAME_CONTROLS_HEIGHT;
const seriesChrome = (games: number, layout: CardLayout): Chrome => ({
    inset: SERIES_INSET,
    height: getSeriesGroupDimensions(games, layout).height
});

/**
 * Container-relative position of `cell` for a member with `chrome`, derived
 * through the SAME row model the engine uses — so a fixture can never encode a
 * position the model would not have produced. For a lone member of a row this
 * is exactly `cellToPosition`, which is why the all-Card fixtures below are
 * unchanged.
 */
const positionOfCell = (cell: GridCell, chrome: Chrome, layout: CardLayout) => {
    const rows = rowsOfIndexed(
        [{ id: "x", index: cell.row, inset: chrome.inset, height: chrome.height }],
        layout
    );
    return {
        x: cellToPosition(cell, layout).x,
        y: memberY(rows[0], chrome.inset)
    };
};

// Minimal GridItem factory. `id` is the node's PLACEMENT identity — a Card's
// draft_id, a Group's id — which is what canvasTree.gridItemsOf emits.
function itemAt(
    id: string,
    x: number,
    y: number,
    layout: CardLayout,
    cols: number,
    footprint: GridFootprint = CARD_FOOTPRINT,
    kind: GridItem["kind"] = "card",
    chrome: Chrome = cardChrome(layout)
): GridItem {
    return {
        id,
        kind,
        footprint,
        position: { x, y },
        cell: positionToCell(x, y, layout, cols),
        inset: chrome.inset,
        height: chrome.height
    };
}

function itemInCell(
    id: string,
    row: number,
    col: number,
    layout: CardLayout,
    footprint: GridFootprint = CARD_FOOTPRINT,
    kind: GridItem["kind"] = "card",
    chrome: Chrome = cardChrome(layout)
): GridItem {
    return {
        id,
        kind,
        footprint,
        position: positionOfCell({ row, col }, chrome, layout),
        cell: { row, col },
        inset: chrome.inset,
        height: chrome.height
    };
}

/**
 * A SET of items materialized together, so members sharing a row get the `y`
 * rule 3 actually gives them. `itemInCell` derives each member's position in
 * isolation, which is right for a uniform row and WRONG for a mixed one — two
 * members built that way both land at the row's top, key to two different row
 * identities, and silently split into two rows. Use this whenever a fixture
 * puts different chrome in the same row.
 */
const itemsInCells = (
    specs: {
        id: string;
        cell: GridCell;
        footprint?: GridFootprint;
        kind?: GridItem["kind"];
        chrome?: Chrome;
    }[],
    layout: CardLayout
): GridItem[] => {
    const chromeOf = (spec: (typeof specs)[number]) => spec.chrome ?? cardChrome(layout);
    const rows = rowsOfIndexed(
        specs.map((spec) => ({
            id: spec.id,
            index: spec.cell.row,
            inset: chromeOf(spec).inset,
            height: chromeOf(spec).height
        })),
        layout
    );
    return specs.map((spec) => {
        const chrome = chromeOf(spec);
        const row = rows.find((r) => r.ids.includes(spec.id));
        return {
            id: spec.id,
            kind: spec.kind ?? "card",
            footprint: spec.footprint ?? CARD_FOOTPRINT,
            position: {
                x: cellToPosition(spec.cell, layout).x,
                y: row ? memberY(row, chrome.inset) : 0
            },
            cell: spec.cell,
            inset: chrome.inset,
            height: chrome.height
        };
    });
};

/** Every item's own cell, as the engine's assignments report them. */
const assignmentsOf = (items: GridItem[]): GridAssignment[] =>
    items.map((i) => ({ id: i.id, kind: i.kind, cell: i.cell }));

/** Targeting rows for a `resolveGridDrop` call: the membership minus `dragged`. */
const targetingRows = (items: GridItem[], draggedId: string, layout: CardLayout) =>
    rowsOfItems(
        items.filter((i) => i.id !== draggedId),
        layout
    );

/**
 * `resolveGridDrop` with the TARGETING membership filled in — the contract
 * every call site owes it, in one place. Including the dragged node in `rows`
 * lets a hovering Bo3 raise its own target row's baseline, shifting the offset,
 * changing which row the point falls in, frame after frame. The tests below
 * would not catch that if each one built `rows` by hand.
 */
const drop = (args: Omit<Parameters<typeof resolveGridDrop>[0], "rows">) =>
    resolveGridDrop({
        ...args,
        rows: targetingRows(args.items, args.dragged.id, args.layout)
    });

// Multi-column footprints, standing in for a wide child such as a series.
// COLUMNS ONLY since §6.0a rule 1: nothing spans rows, the row grows instead.
const SPAN4: GridFootprint = { cols: 4 };
const SPAN6: GridFootprint = { cols: 6 };

describe("cell math", () => {
    it("round-trips cell -> position -> cell for every layout", () => {
        for (const layout of LAYOUTS) {
            for (const cell of [
                { row: 0, col: 0 },
                { row: 2, col: 1 },
                { row: 5, col: 2 }
            ]) {
                const pos = cellToPosition(cell, layout);
                expect(positionToCell(pos.x, pos.y, layout, 3)).toEqual(cell);
            }
        }
    });

    it("snaps a position offset by less than half a cell back to the same cell", () => {
        const pos = cellToPosition({ row: 1, col: 1 }, "wide");
        const cell = positionToCell(pos.x + 100, pos.y - 100, "wide", 3);
        expect(cell).toEqual({ row: 1, col: 1 });
    });

    it("clamps col into [0, cols-1] and row to >= 0", () => {
        expect(positionToCell(-500, -500, "wide", 3)).toEqual({ row: 0, col: 0 });
        expect(positionToCell(99999, 0, "wide", 3).col).toBe(2);
    });
});

describe("rowCells", () => {
    it("covers one row and `cols` columns", () => {
        expect(rowCells({ row: 2, col: 1 }, { cols: 3 })).toEqual([
            { row: 2, col: 1 },
            { row: 2, col: 2 },
            { row: 2, col: 3 }
        ]);
    });

    it("never covers a second row — the row grows instead", () => {
        expect(rowCells({ row: 0, col: 0 }, { cols: 5 }).every((c) => c.row === 0)).toBe(
            true
        );
    });

    it("clamps a zero or negative span to one column", () => {
        expect(rowCells({ row: 0, col: 0 }, { cols: 0 })).toEqual([{ row: 0, col: 0 }]);
        expect(rowCells({ row: 0, col: 0 }, { cols: -3 })).toEqual([{ row: 0, col: 0 }]);
    });
});

describe("firstEmptyRect", () => {
    it("returns 0,0 for an empty group", () => {
        expect(firstEmptyRect([], CARD_FOOTPRINT, 3)).toEqual({ row: 0, col: 0 });
    });

    it("skips occupied cells in reading order", () => {
        const items = [itemInCell("a", 0, 0, "wide"), itemInCell("b", 0, 1, "wide")];
        expect(firstEmptyRect(items, CARD_FOOTPRINT, 3)).toEqual({ row: 0, col: 2 });
    });

    it("wraps to the next row when a row is full", () => {
        const items = [
            itemInCell("a", 0, 0, "wide"),
            itemInCell("b", 0, 1, "wide"),
            itemInCell("c", 0, 2, "wide")
        ];
        expect(firstEmptyRect(items, CARD_FOOTPRINT, 3)).toEqual({ row: 1, col: 0 });
    });

    it("skips every cell a wide footprint covers, not just its top-left", () => {
        // A Bo3 at (0,0) blocks cols 0-3 of rows 0-1, so a Card fits at (0,4)
        // and NOT at (0,1) — the bug a top-left-only occupancy set has.
        const items = [itemInCell("s", 0, 0, "wide", SPAN4, "group")];
        expect(firstEmptyRect(items, CARD_FOOTPRINT, 6)).toEqual({ row: 0, col: 4 });
    });

    it("finds the first cell where the WHOLE footprint fits", () => {
        // One Card at (0,0). A Bo3 needs 4 free columns across 2 rows, so it
        // cannot start at (0,0), and in a 5-column grid the only other legal
        // start on row 0 is (0,1) — cols 1-4, clear of the card.
        const items = [itemInCell("a", 0, 0, "wide")];
        expect(firstEmptyRect(items, SPAN4, 5)).toEqual({ row: 0, col: 1 });
    });

    it("drops to the next row when no start column on this one fits", () => {
        const items = [itemInCell("a", 0, 1, "wide")];
        // Legal starts in a 5-column grid are cols 0 and 1; both cover (0,1).
        expect(firstEmptyRect(items, SPAN4, 5)).toEqual({ row: 1, col: 0 });
    });

    it("terminates on a footprint wider than the grid instead of scanning forever", () => {
        // copyPlacement calls this with the CONFIGURED column count, which can
        // be narrower than a child. Clamping to column 0 overhangs; not
        // clamping never finds a legal column at all.
        expect(firstEmptyRect([], SPAN6, 3)).toEqual({ row: 0, col: 0 });
    });
});

describe("nearestFreeRect", () => {
    it("prefers a neighbouring cell over the first empty one", () => {
        const items = [itemInCell("a", 2, 0, "wide"), itemInCell("b", 2, 1, "wide")];
        // Reading order would say (0,0). Three cells are one step from (2,1) —
        // (1,1), (2,2) and (3,1) — and the reading-order tie-break takes the
        // first, which is a whole row nearer than firstEmptyRect's answer.
        expect(nearestFreeRect(items, CARD_FOOTPRINT, { row: 2, col: 1 }, 3)).toEqual({
            row: 1,
            col: 1
        });
    });

    it("breaks ties in reading order", () => {
        const items = [itemInCell("a", 1, 1, "wide")];
        // (0,1) and (1,0) and (1,2) and (2,1) are all distance 1 from (1,1).
        expect(nearestFreeRect(items, CARD_FOOTPRINT, { row: 1, col: 1 }, 3)).toEqual({
            row: 0,
            col: 1
        });
    });

    it("falls past every occupant when the grid is full above", () => {
        const items = [
            itemInCell("a", 0, 0, "wide"),
            itemInCell("b", 0, 1, "wide"),
            itemInCell("c", 1, 0, "wide"),
            itemInCell("d", 1, 1, "wide")
        ];
        expect(nearestFreeRect(items, CARD_FOOTPRINT, { row: 0, col: 0 }, 2)).toEqual({
            row: 2,
            col: 0
        });
    });
});

describe("materializeGrid", () => {
    const layout: CardLayout = "wide";
    const ch = cardHeight(layout);
    const SERIES_H = getSeriesGroupDimensions(3, layout).height;
    /** How much a Card drops when a series joins its row — rule 3, as a number. */
    const BASELINE_DROP = SERIES_INSET - CARD_INSET;
    /** How much taller a series row is than a Card row — rule 2, as a number. */
    const ROW_GROWTH = SERIES_H - ch;

    const gridCard = (id: string, cell: GridCell) =>
        itemInCell(id, cell.row, cell.col, layout);
    const gridSeries = (id: string, cell: GridCell, games: number) =>
        itemInCell(
            id,
            cell.row,
            cell.col,
            layout,
            { cols: games },
            "group",
            seriesChrome(games, layout)
        );

    it("returns nothing when no member moved", () => {
        const items = [
            gridCard("a", { row: 0, col: 0 }),
            gridCard("b", { row: 0, col: 1 })
        ];
        expect(
            materializeGrid({ items, assignments: assignmentsOf(items), layout })
                .placements
        ).toEqual([]);
    });

    it("moves ONLY the reassigned member in an all-Card grid", () => {
        const items = [
            gridCard("a", { row: 0, col: 0 }),
            gridCard("b", { row: 0, col: 1 })
        ];
        const { placements } = materializeGrid({
            items,
            assignments: [
                { id: "a", kind: "card", cell: { row: 0, col: 0 } },
                { id: "b", kind: "card", cell: { row: 1, col: 0 } }
            ],
            layout
        });
        expect(placements.map((p) => p.id)).toEqual(["b"]);
    });

    // The cascade §6.0a's "three memberships" section describes.
    it("drops every Card in a row to the baseline when a series joins it", () => {
        const card = gridCard("c", { row: 0, col: 3 });
        const series = gridSeries("s", { row: 0, col: 0 }, 3);
        const { placements } = materializeGrid({
            items: [card, series],
            assignments: [
                { id: "c", kind: "card", cell: { row: 0, col: 3 } },
                { id: "s", kind: "group", cell: { row: 0, col: 0 } }
            ],
            layout
        });
        expect(BASELINE_DROP).toBeGreaterThan(0);
        expect(placements.find((p) => p.id === "c")?.positionY).toBe(
            card.position.y + BASELINE_DROP
        );
        // The series owns the baseline, so it sits flush at the row's top and
        // does not move at all.
        expect(placements.find((p) => p.id === "s")).toBeUndefined();
    });

    it("pushes the rows BELOW a grown row down by the height it gained", () => {
        const below = gridCard("b", { row: 1, col: 0 });
        const series = gridSeries("s", { row: 0, col: 0 }, 3);
        const { placements } = materializeGrid({
            items: [series, below],
            assignments: [
                { id: "s", kind: "group", cell: { row: 0, col: 0 } },
                { id: "b", kind: "card", cell: { row: 1, col: 0 } }
            ],
            layout
        });
        expect(ROW_GROWTH).toBeGreaterThan(0);
        expect(placements.find((p) => p.id === "b")?.positionY).toBe(
            below.position.y + ROW_GROWTH
        );
    });

    it("keeps x on the column lattice, untouched by the row work", () => {
        const items = [gridCard("a", { row: 0, col: 0 })];
        const { placements } = materializeGrid({
            items,
            assignments: [{ id: "a", kind: "card", cell: { row: 0, col: 2 } }],
            layout
        });
        expect(placements[0].positionX).toBe(
            GRID_PADDING + 2 * (cardWidth(layout) + GRID_CELL_GAP)
        );
    });

    // A pure COLUMN move must not be swallowed by the "did anything change?"
    // filter — the y is identical on both sides of it.
    it("emits a placement for a pure column move", () => {
        const items = [gridCard("a", { row: 0, col: 0 })];
        const { placements } = materializeGrid({
            items,
            assignments: [{ id: "a", kind: "card", cell: { row: 0, col: 1 } }],
            layout
        });
        expect(placements.map((p) => p.id)).toEqual(["a"]);
        expect(placements[0].positionY).toBe(items[0].position.y);
    });

    it("leaves an UNASSIGNED member's x alone rather than re-rounding it", () => {
        // A member nudged off the exact column lattice, and a different member
        // reassigned. Recomputing x from `cell.col` under whichever `cols` the
        // call site used would drag this one sideways for no reason.
        const nudged = { ...gridCard("a", { row: 0, col: 1 }) };
        nudged.position = { x: nudged.position.x + 7, y: nudged.position.y };
        const series = gridSeries("s", { row: 0, col: 0 }, 1);
        const { placements } = materializeGrid({
            items: [nudged, series],
            assignments: [{ id: "s", kind: "group", cell: { row: 0, col: 0 } }],
            layout
        });
        expect(placements.find((p) => p.id === "a")?.positionX).toBe(nudged.position.x);
    });

    it("materializes a member assigned to a growth row past the end", () => {
        const existing = gridCard("a", { row: 0, col: 0 });
        const entering = gridCard("new", { row: 1, col: 0 });
        const { placements } = materializeGrid({
            items: [existing, entering],
            assignments: [
                { id: "a", kind: "card", cell: { row: 0, col: 0 } },
                { id: "new", kind: "card", cell: { row: 1, col: 0 } }
            ],
            layout
        });
        // `entering` was already fixtured at row 1, so it does not move; what
        // this pins is that a row past the end resolves at all.
        expect(placements).toEqual([]);
    });

    it("keeps sparse assignments sparse — row 3 of a one-row grid stays row 3", () => {
        const items = [
            gridCard("a", { row: 0, col: 0 }),
            gridCard("b", { row: 0, col: 1 })
        ];
        const { rows } = materializeGrid({
            items,
            assignments: [
                { id: "a", kind: "card", cell: { row: 0, col: 0 } },
                { id: "b", kind: "card", cell: { row: 3, col: 0 } }
            ],
            layout
        });
        expect(rows.map((r) => r.index)).toEqual([0, 3]);
    });

    // The contract that stops a caller silently mis-aligning an incoming
    // nested container by defaulting it to a Card's geometry.
    it("throws on an assignment with no item, rather than guessing its chrome", () => {
        expect(() =>
            materializeGrid({
                items: [gridCard("a", { row: 0, col: 0 })],
                assignments: [{ id: "ghost", kind: "card", cell: { row: 0, col: 1 } }],
                layout
            })
        ).toThrow(/no item/);
    });

    it("returns the EXACT post-drop rows, not something to be re-inferred", () => {
        const card = gridCard("c", { row: 0, col: 3 });
        const series = gridSeries("s", { row: 0, col: 0 }, 3);
        const { rows } = materializeGrid({
            items: [card, series],
            assignments: [
                { id: "c", kind: "card", cell: { row: 0, col: 3 } },
                { id: "s", kind: "group", cell: { row: 0, col: 0 } }
            ],
            layout
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].baseline).toBe(SERIES_INSET);
        expect(rows[0].height).toBe(SERIES_H);
    });

    // Round-trip: what materializeGrid WRITES must read back through the
    // inferential path as the same rows. This is the property that makes
    // `rematerializeGrid` idempotent and pixel authority coherent.
    it("round-trips through rowsOfItems: materialized pixels re-derive the same rows", () => {
        const card = gridCard("c", { row: 0, col: 3 });
        const series = gridSeries("s", { row: 0, col: 0 }, 3);
        const below = gridCard("b", { row: 1, col: 0 });
        const items = [card, series, below];
        const assignments = assignmentsOf(items);
        const { placements, rows } = materializeGrid({ items, assignments, layout });
        const settled = items.map((i) => {
            const moved = placements.find((p) => p.id === i.id);
            return moved
                ? { ...i, position: { x: moved.positionX, y: moved.positionY } }
                : i;
        });
        expect(rowsOfItems(settled, layout)).toEqual(rows);
        // ...and materializing again writes nothing.
        expect(
            materializeGrid({ items: settled, assignments, layout }).placements
        ).toEqual([]);
    });
});

describe("landing metrics vs targeting metrics (§6.0a, three memberships)", () => {
    const layout: CardLayout = "wide";

    it("targeting EXCLUDES the dragged node, so a hovering Bo3 cannot move its own target row", () => {
        // Both genuinely in row 0, materialized together — a hovering Bo3 that
        // is ALREADY counted has raised the row's baseline, which is the state
        // the targeting membership must not be computed from.
        const [resident, bo3] = itemsInCells(
            [
                { id: "r", cell: { row: 0, col: 0 } },
                {
                    id: "s",
                    cell: { row: 0, col: 1 },
                    kind: "group",
                    footprint: { cols: 3 },
                    chrome: seriesChrome(3, layout)
                }
            ],
            layout
        );
        const targeting = rowsOfItems([resident], layout);
        const withDragged = rowsOfItems([resident, bo3], layout);
        expect(withDragged).toHaveLength(1);
        expect(targeting[0].baseline).toBe(resident.inset);
        expect(withDragged[0].baseline).toBe(bo3.inset);
        // The row's OFFSET is what `rowAtY` compares against, and including the
        // dragged node moves it — which is the oscillation this rule prevents.
        expect(targeting[0].height).not.toBe(withDragged[0].height);
    });

    it("landing INCLUDES it, so the highlight is drawn where the node will actually be", () => {
        const resident = itemInCell("r", 0, 3, layout);
        const bo3 = itemInCell(
            "s",
            0,
            0,
            layout,
            { cols: 3 },
            "group",
            seriesChrome(3, layout)
        );
        const { placements } = materializeGrid({
            items: [resident, bo3],
            assignments: [
                { id: "r", kind: "card", cell: { row: 0, col: 3 } },
                { id: "s", kind: "group", cell: { row: 0, col: 0 } }
            ],
            layout
        });
        // The resident Card moves even though it was not dragged.
        expect(placements.map((p) => p.id)).toContain("r");
    });
});

describe("resolveGridDrop", () => {
    const draggedCard = (id: string) => ({
        id,
        kind: "card" as const,
        footprint: CARD_FOOTPRINT
    });

    it("snaps into an empty cell: one placement, no swap", () => {
        const a = itemInCell("a", 0, 0, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = drop({
            items: [a, itemAt("dragged", target.x + 30, target.y - 10, "wide", 3)],
            dragged: draggedCard("dragged"),
            draggedOrigin: null,
            dropX: target.x + 30,
            dropY: target.y - 10,
            layout: "wide",
            cols: 3
        });
        expect(placements).toEqual([
            { id: "dragged", kind: "card", cell: { row: 0, col: 1 } }
        ]);
    });

    it("swap with origin: occupant moves to the dragged card's origin cell", () => {
        const origin = cellToPosition({ row: 1, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const occupant = itemInCell("occ", 0, 0, "wide");
        const dragged = itemAt("dragged", target.x + 5, target.y + 5, "wide", 3);
        const placements = drop({
            items: [occupant, dragged],
            dragged: draggedCard("dragged"),
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(placements).toContainEqual({
            id: "dragged",
            kind: "card",
            cell: { row: 0, col: 0 }
        });
        expect(placements).toContainEqual({
            id: "occ",
            kind: "card",
            cell: { row: 1, col: 0 }
        });
    });

    it("swap without origin (card entering from outside): occupant moves to first empty cell", () => {
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const occupant = itemInCell("occ", 0, 0, "wide");
        const placements = drop({
            items: [occupant],
            dragged: draggedCard("dragged"),
            draggedOrigin: null,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(placements).toContainEqual({
            id: "occ",
            kind: "card",
            cell: { row: 0, col: 1 }
        });
    });

    it("refuses to swap a Card with a multi-column node: the Card takes the nearest free rect", () => {
        // Decision 7: swap survives only for one-column Card <-> Card.
        // Evicting a whole series because a Card landed on one of its cells is
        // the failure mode this rule exists to prevent.
        const series = itemInCell("bo3", 0, 0, "wide", SPAN4, "group");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = drop({
            items: [series],
            dragged: draggedCard("dragged"),
            draggedOrigin: { x: 0, y: 0 },
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(placements).toHaveLength(1);
        expect(placements[0].id).toBe("dragged");
        // The series is untouched, and the card takes the nearest free cell to
        // (0,1) — ONE row straight down, not three columns across. It was two
        // rows under the retired multi-row stamp; §6.0a rule 1 frees the row
        // directly beneath a series, because the series no longer claims it.
        expect(placements[0].cell).toEqual({ row: 1, col: 1 });
    });

    it("relocates a wide dragged node rather than displacing the card it lands on", () => {
        const card = itemInCell("a", 0, 0, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const placements = drop({
            items: [card],
            dragged: { id: "bo3", kind: "group", footprint: SPAN4 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(placements.map((p) => p.id)).toEqual(["bo3"]);
        // A Bo3 needs 4 free columns across 2 rows; (0,1) collides with nothing
        // but overhangs (cols 1-4 of 6 is fine), so it lands there.
        expect(placements[0].cell).toEqual({ row: 0, col: 1 });
    });

    it("clamps the target so a wide footprint cannot overhang the last column", () => {
        const target = cellToPosition({ row: 0, col: 5 }, "wide");
        const placements = drop({
            items: [],
            dragged: { id: "bo3", kind: "group", footprint: SPAN4 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(placements[0].cell).toEqual({ row: 0, col: 2 });
    });
});

// 5a-4b's north star, at the engine level: a rectangular dragged node entering
// a grid container.
describe("resolveGridDrop with a rectangular dragged Group", () => {
    it("places a Bo3 at the cell under the drop when the rectangle is free", () => {
        const target = cellToPosition({ row: 2, col: 0 }, "wide");
        const placements = drop({
            items: [itemInCell("card", 0, 0, "wide")],
            dragged: { id: "bo3", kind: "group", footprint: SPAN4 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements).toEqual([
            { id: "bo3", kind: "group", cell: { row: 2, col: 0 } }
        ]);
    });

    // V1's expectation correction, as arithmetic: `effectiveGridCols` owes its
    // `+1` to the CONFIGURED term only, so a Bo3 (4 cols) in a 4-column lattice
    // has `lastStartCol` 0 and lands in column 0 wherever it is released.
    it("clamps a full-width rectangle to column 0 however far right it is dropped", () => {
        const target = cellToPosition({ row: 1, col: 3 }, "wide");
        const placements = drop({
            items: [],
            dragged: { id: "bo3", kind: "group", footprint: SPAN4 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements[0].cell).toEqual({ row: 1, col: 0 });
    });

    it("relocates the DRAGGED rectangle on a collision and leaves occupants alone", () => {
        // A Card at (0,1) sits inside the Bo3's 2x4 rectangle at (0,0).
        const card = itemInCell("card", 0, 1, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const placements = drop({
            items: [card],
            dragged: { id: "bo3", kind: "group", footprint: SPAN4 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements).toHaveLength(1);
        expect(placements[0].id).toBe("bo3");
        expect(placements[0].cell.row).toBeGreaterThan(0);
    });

    it("overhangs from column 0 when the child is wider than the grid", () => {
        // A Bo5 is 6 columns; the grid offers 4. `lastStartCol` clamps to 0
        // rather than scanning forever for a column that fits (step-3 fix).
        const target = cellToPosition({ row: 0, col: 2 }, "wide");
        const placements = drop({
            items: [],
            dragged: { id: "bo5", kind: "group", footprint: SPAN6 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements[0].cell).toEqual({ row: 0, col: 0 });
    });

    it("does not evict a series when a rectangle lands on one", () => {
        const series = itemInCell("bo3", 0, 0, "wide", SPAN4, "group");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const placements = drop({
            items: [series],
            dragged: { id: "bo5", kind: "group", footprint: SPAN6 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(placements.map((p) => p.id)).toEqual(["bo5"]);
        // Directly below the series, which is the only free band — the series
        // occupies exactly one row (§6.0a rule 1), not two.
        expect(placements[0].cell.row).toBe(1);
    });
});

describe("kind-gated swap (decision 7, amended round 2)", () => {
    it("swaps two 1x1 CARDS, as before", () => {
        const occupant = itemInCell("occupant", 0, 1, "wide");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = drop({
            items: [occupant],
            dragged: { id: "dragged", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 3
        });
        expect(placements).toHaveLength(2);
        expect(placements[1].cell).toEqual({ row: 0, col: 0 });
    });

    // A default 400x200 Group is 1x1 in four of the six layouts, so `isUnit`
    // alone made the swap layout-dependent — and cardLayout is canvas-level and
    // broadcast, so one user's display toggle changed everyone's drop gesture.
    it("never evicts a 1x1 GROUP; the dragged Card relocates instead", () => {
        const occupant = itemInCell("nested", 0, 1, "wide", CARD_FOOTPRINT, "group");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = drop({
            items: [occupant],
            dragged: { id: "dragged", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 3
        });
        expect(placements).toHaveLength(1);
        expect(placements[0].id).toBe("dragged");
        expect(placements[0].cell).not.toEqual({ row: 0, col: 1 });
    });

    it("never lets a 1x1 GROUP evict a Card either", () => {
        const occupant = itemInCell("card", 0, 1, "wide");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = drop({
            items: [occupant],
            dragged: { id: "dragged", kind: "group", footprint: CARD_FOOTPRINT },
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 3
        });
        expect(placements).toHaveLength(1);
        expect(placements[0].id).toBe("dragged");
    });
});

describe("arrangeGrid", () => {
    it("keeps already-tidy items in place", () => {
        const items = [itemInCell("a", 0, 0, "wide"), itemInCell("b", 0, 1, "wide")];
        const placements = arrangeGrid(items, 3);
        expect(placements.find((u) => u.id === "a")).toEqual({
            id: "a",
            kind: "card",
            cell: { row: 0, col: 0 }
        });
    });

    it("resolves two items nearest the same cell: second goes to next empty cell in reading order", () => {
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        const items = [
            itemAt("a", p.x + 5, p.y + 5, "wide", 3),
            itemAt("b", p.x + 40, p.y + 40, "wide", 3)
        ];
        const cells = arrangeGrid(items, 3).map((u) => u.cell);
        expect(cells).toContainEqual({ row: 0, col: 0 });
        expect(cells).toContainEqual({ row: 0, col: 1 });
    });

    // Converting an EMPTY group to grid is a real user action ("Arrange as
    // grid" on a group with no cards), and it produces no position updates at
    // all — the whole request is carried by the group's dims + metadata. The
    // backend guard used to reject that as "positions must be a non-empty
    // array", so the conversion silently failed to persist behind an
    // optimistic store write.
    it("returns no assignments for an empty group, leaving the group to carry the work", () => {
        const assignments = arrangeGrid([], 3);
        expect(assignments).toEqual([]);

        const rows = rowCountAfter([], [], "wide", 3);
        expect(rows).toBe(1);

        const dims = gridDimensions(rows, 3, "wide");
        expect(dims.width).toBeGreaterThan(0);
        expect(dims.height).toBeGreaterThan(0);
    });

    it("assigns every item a unique cell", () => {
        const items = Array.from({ length: 7 }, (_, i) =>
            itemAt(`d${i}`, 10 * i, 5 * i, "compact", 3)
        );
        const keys = new Set(
            arrangeGrid(items, 3).map((u) => {
                const c = u.cell;
                return `${c.row}:${c.col}`;
            })
        );
        expect(keys.size).toBe(7);
    });

    it("packs rectangles without overlap, keeping the series atomic", () => {
        const items = [
            itemInCell("bo3", 0, 0, "wide", SPAN4, "group"),
            itemInCell("a", 0, 1, "wide"),
            itemInCell("b", 0, 2, "wide")
        ];
        const placements = arrangeGrid(items, 6);
        const cells = new Map(placements.map((p) => [p.id, p.cell]));
        expect(cells.get("bo3")).toEqual({ row: 0, col: 0 });
        // Both cards are pushed clear of the series' 2x4 block.
        const covered = new Set(
            rowCells({ row: 0, col: 0 }, SPAN4).map((c: GridCell) => `${c.row}:${c.col}`)
        );
        for (const id of ["a", "b"]) {
            const cell = cells.get(id);
            expect(cell).toBeDefined();
            expect(covered.has(`${cell?.row}:${cell?.col}`)).toBe(false);
        }
        expect(`${cells.get("a")?.row}:${cells.get("a")?.col}`).not.toBe(
            `${cells.get("b")?.row}:${cells.get("b")?.col}`
        );
    });
});

describe("reflowAfterGrowth", () => {
    it("keeps the grown node's top-left cell and displaces what it now covers (series Bo3 -> Bo5)", () => {
        // The series already carries its Bo5 footprint; the card that was at
        // (0,4) is now inside it.
        const items = [
            itemInCell("series", 0, 0, "wide", SPAN6, "group"),
            itemInCell("card", 0, 4, "wide")
        ];
        const placements = reflowAfterGrowth({
            items,
            grownId: "series",
            cols: 6
        });
        // The grown node does not move, so it produces no placement.
        expect(placements.map((p) => p.id)).toEqual(["card"]);
        const cell = placements[0].cell;
        const covered = new Set(
            rowCells({ row: 0, col: 0 }, SPAN6).map((c: GridCell) => `${c.row}:${c.col}`)
        );
        expect(covered.has(`${cell.row}:${cell.col}`)).toBe(false);
        // Nearest free rect from (0,4) is straight down, out of the series —
        // one row, not two, now that a series claims only its own row.
        expect(cell).toEqual({ row: 1, col: 4 });
    });

    it("grows a resized nested Group right/down rather than relocating it", () => {
        const items = [
            itemInCell("child", 1, 1, "wide", { cols: 2 }, "group"),
            itemInCell("a", 1, 2, "wide"),
            itemInCell("b", 3, 0, "wide")
        ];
        const placements = reflowAfterGrowth({
            items,
            grownId: "child",
            cols: 4
        });
        // "b" is clear of the grown rect, so it is untouched; only "a" moves.
        expect(placements.map((p) => p.id)).toEqual(["a"]);
        expect(placements[0].cell).toEqual({ row: 0, col: 2 });
    });

    it("resolves the overlaps a card-layout change creates among untouched siblings", () => {
        // A narrower unit cell collapses three items onto two cells. The pinned
        // node keeps its cell; the rest are re-placed without overlapping.
        const items = [
            itemInCell("pinned", 0, 0, "compact", CARD_FOOTPRINT),
            itemInCell("a", 0, 0, "compact", CARD_FOOTPRINT),
            itemInCell("b", 0, 1, "compact", CARD_FOOTPRINT),
            itemInCell("c", 0, 1, "compact", CARD_FOOTPRINT)
        ];
        const placements = reflowAfterGrowth({
            items,
            grownId: "pinned",
            cols: 3
        });
        const cells = new Map(items.map((i) => [i.id, `${i.cell.row}:${i.cell.col}`]));
        for (const p of placements) {
            const c = p.cell;
            cells.set(p.id, `${c.row}:${c.col}`);
        }
        expect(cells.get("pinned")).toBe("0:0");
        expect(new Set(cells.values()).size).toBe(4);
    });

    it("returns nothing when the grown node is not in the grid", () => {
        expect(
            reflowAfterGrowth({
                items: [itemInCell("a", 0, 0, "wide")],
                grownId: "ghost",
                cols: 3
            })
        ).toEqual([]);
    });
});

describe("toPositionUpdates", () => {
    it("emits the wire shape for Cards and drops Group placements", () => {
        expect(
            toPositionUpdates([
                { id: "card", kind: "card", positionX: 1, positionY: 2 },
                { id: "group", kind: "group", positionX: 3, positionY: 4 }
            ])
        ).toEqual([{ draft_id: "card", positionX: 1, positionY: 2 }]);
    });
});

describe("footprintPixelWidth", () => {
    it("is exactly one card wide for a unit footprint, in every layout", () => {
        for (const layout of LAYOUTS) {
            expect(footprintPixelWidth(CARD_FOOTPRINT, layout)).toBe(cardWidth(layout));
        }
    });

    it("puts the gaps INSIDE the span, inverting spanFor", () => {
        expect(footprintPixelWidth(SPAN4, "wide")).toBe(
            4 * cardWidth("wide") + 3 * GRID_CELL_GAP
        );
    });

    it("clamps a degenerate footprint to one cell", () => {
        expect(footprintPixelWidth({ cols: 0 }, "wide")).toBe(cardWidth("wide"));
    });

    // There is deliberately no height half. A row's height is a property of
    // its MEMBERSHIP (`gridRows.rowsOf`), not of any one footprint, so a
    // `rows * cardHeight` answer could only ever be wrong for the drop
    // highlight that consumes it.
});

describe("gridDimensions", () => {
    it("computes container size incl. header for rows x cols", () => {
        const dims = gridDimensions(2, 3, "wide");
        expect(dims.width).toBe(
            2 * GRID_PADDING + 3 * cardWidth("wide") + 2 * GRID_CELL_GAP
        );
        expect(dims.height).toBe(
            GRID_HEADER_HEIGHT +
                2 * GRID_PADDING +
                2 * cardHeight("wide") +
                1 * GRID_CELL_GAP
        );
    });
});

describe("rowCountAfter", () => {
    it("counts rows from both pending placements and untouched items", () => {
        const settled = itemInCell("settled", 2, 0, "wide");
        const moving = itemInCell("moving", 4, 0, "wide");
        const p = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = [
            { id: "moving", kind: "card" as const, positionX: p.x, positionY: p.y }
        ];
        expect(rowCountAfter(placements, [settled, moving], "wide", 3)).toBe(3);
    });

    // §6.0a rule 1 retired the multi-row stamp, so a footprint's bottom row IS
    // its top row and this collapses to "the deepest occupied row, plus one".
    // Task 5 deletes the function outright when gridContentHeight takes over.
    it("counts the deepest occupied row, which no footprint extends past", () => {
        const series = itemInCell("bo3", 1, 0, "wide", SPAN4, "group");
        expect(rowCountAfter([], [series], "wide", 6)).toBe(2);
        const card = itemInCell("c", 1, 0, "wide");
        expect(rowCountAfter([], [card], "wide", 6)).toBe(2);
    });
});

describe("column growth", () => {
    function gridGroup(gridCols: number, width: number | null): CanvasGroup {
        return {
            id: "g1",
            canvas_id: "c1",
            name: "Grid",
            type: "custom",
            positionX: 0,
            positionY: 0,
            width,
            height: 400,
            metadata: { layout: "grid", gridCols }
        };
    }

    it("colsFromWidth matches the width gridDimensions computes", () => {
        for (const layout of LAYOUTS) {
            for (const cols of [1, 3, 5]) {
                const { width } = gridDimensions(1, cols, layout);
                expect(colsFromWidth(width, layout)).toBe(cols);
                // A hair narrower than the next column keeps the count.
                expect(colsFromWidth(width + cardWidth(layout) - 1, layout)).toBe(cols);
                // Room for one more full column raises it.
                expect(
                    colsFromWidth(width + cardWidth(layout) + GRID_CELL_GAP, layout)
                ).toBe(cols + 1);
            }
        }
    });

    it("colsFromWidth never returns less than 1", () => {
        expect(colsFromWidth(0, "wide")).toBe(1);
    });

    it("effectiveGridCols is configured cols + 1 growth column at content width", () => {
        const { width } = gridDimensions(1, 3, "wide");
        expect(effectiveGridCols(gridGroup(3, width), "wide")).toBe(4);
    });

    it("effectiveGridCols follows width when the group is resized wider", () => {
        const { width } = gridDimensions(1, 6, "wide");
        expect(effectiveGridCols(gridGroup(3, width), "wide")).toBe(6);
    });

    it("effectiveGridCols tolerates a missing width", () => {
        expect(effectiveGridCols(gridGroup(3, null), "wide")).toBe(4);
    });

    it("effectiveGridCols widens to fit the widest child, with no extra growth column", () => {
        // A Bo5 is 6 columns wide. The +1 is owed to the CONFIGURED term only:
        // a six-wide child needs six columns, not seven.
        expect(effectiveGridCols(gridGroup(3, null), "wide", SPAN6.cols)).toBe(6);
    });

    it("effectiveGridCols keeps the growth column when no child dominates", () => {
        expect(effectiveGridCols(gridGroup(3, null), "wide", 1)).toBe(4);
    });

    it("resolveGridDrop lands in a growth column when cols allow it", () => {
        const a = itemInCell("a", 0, 2, "wide");
        const target = cellToPosition({ row: 0, col: 3 }, "wide");
        const placements = drop({
            items: [a],
            dragged: { id: "dragged", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: null,
            dropX: target.x + 10,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements).toEqual([
            { id: "dragged", kind: "card", cell: { row: 0, col: 3 } }
        ]);
    });
});

describe("mergeLabels", () => {
    it("overwrites the first `count` entries with trimmed edited values", () => {
        expect(mergeLabels([], ["  A  ", "B"], 2)).toEqual(["A", "B"]);
    });

    it("preserves stored entries beyond `count` (grid grew via drag)", () => {
        // Dialog only knew about 2 columns; a 3rd was created by dragging.
        expect(mergeLabels(["A", "B", "keep"], ["A2", "B2"], 2)).toEqual([
            "A2",
            "B2",
            "keep"
        ]);
    });

    it("trims trailing empties but keeps interior holes", () => {
        expect(mergeLabels([], ["A", "", "C", "", ""], 5)).toEqual(["A", "", "C"]);
    });

    it("trims whitespace-only preserved entries so trailing empties still drop", () => {
        // A stored "   " beyond `count` must not block trailing-empty removal.
        expect(mergeLabels(["A", "   "], ["A"], 1)).toEqual(["A"]);
    });

    it("pads when count exceeds existing length", () => {
        expect(mergeLabels(["A"], ["A", "B", "C"], 3)).toEqual(["A", "B", "C"]);
    });

    it("returns an empty array when everything is blank", () => {
        expect(mergeLabels([], ["", "  "], 2)).toEqual([]);
    });
});

describe("buildGridMetadata", () => {
    const settings = {
        gridCols: 2,
        rowLabels: ["r1", "r2"],
        colLabels: ["c1", "c2"]
    };

    it("always emits grid layout, the column count, and both label arrays", () => {
        const meta = buildGridMetadata({}, settings);
        expect(meta.layout).toBe("grid");
        expect(meta.gridCols).toBe(2);
        expect(meta.colLabels).toEqual(["c1", "c2"]);
        expect(meta.rowLabels).toEqual(["r1", "r2"]);
    });

    it("preserves stored labels beyond the new column count (regression: no truncation)", () => {
        const meta = buildGridMetadata(
            { colLabels: ["old1", "old2", "old3"], rowLabels: ["x", "y", "z"] },
            settings
        );
        // gridCols=2 overwrites first 2 cols, keeps the 3rd; rows overwrite all 2 shown, keep 3rd.
        expect(meta.colLabels).toEqual(["c1", "c2", "old3"]);
        expect(meta.rowLabels).toEqual(["r1", "r2", "z"]);
    });
});

describe("arrangedRowCount", () => {
    it("returns 1 for an empty group", () => {
        expect(arrangedRowCount([], 3)).toBe(1);
    });

    it("reflects spread-out ideal rows, not ceil(count / cols)", () => {
        // Items whose positions sit at rows 0 and 3. arrangeGrid preserves the
        // ideal row, so the grid spans 4 rows even though ceil(2/3) === 1.
        const items = [itemInCell("a", 0, 0, "wide"), itemInCell("b", 3, 1, "wide")];
        expect(arrangedRowCount(items, 3)).toBe(4);
    });

    it("counts collision overflow into later rows", () => {
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        const items = Array.from({ length: 4 }, (_, i) =>
            itemAt(`d${i}`, p.x + i, p.y + i, "wide", 1)
        );
        // cols=1 forces the four near-(0,0) items into rows 0..3.
        expect(arrangedRowCount(items, 1)).toBe(4);
    });
});

describe("resolveGridSave", () => {
    const settings = { gridCols: 3, rowLabels: ["r"], colLabels: ["c1", "c2", "c3"] };

    it("reflows and emits labeled grid metadata for a free group", () => {
        const { metadata, reflow } = resolveGridSave({ layout: "free" }, settings);
        expect(reflow).toBe(true);
        expect(metadata.layout).toBe("grid");
        expect(metadata.colLabels).toEqual(["c1", "c2", "c3"]);
        expect(metadata.rowLabels).toEqual(["r"]);
    });

    it("reflows when an existing grid's column count changes, keeping labels", () => {
        const { metadata, reflow } = resolveGridSave(
            { layout: "grid", gridCols: 2 },
            settings
        );
        expect(reflow).toBe(true);
        expect(metadata.colLabels).toEqual(["c1", "c2", "c3"]);
        expect(metadata.rowLabels).toEqual(["r"]);
    });

    it("does not reflow a labels-only edit, but still carries labels (regression)", () => {
        const { metadata, reflow } = resolveGridSave(
            { layout: "grid", gridCols: 3 },
            settings
        );
        expect(reflow).toBe(false);
        expect(metadata.rowLabels).toEqual(["r"]);
        expect(metadata.colLabels).toEqual(["c1", "c2", "c3"]);
    });
});

// 5a-0. Every sizing path used to be Math.max(current, content), which cannot
// shrink: a container that grew once stayed grown, and because
// effectiveGridCols reads colsFromWidth, a 3-column grid that briefly held a
// Bo5 stayed 6-column forever with metadata.gridCols === 3 and no gesture that
// undid it. The fix is a STORED manual floor, so "the user chose this width"
// and "we grew to this width for something that has since left" stop being the
// same number.
describe("container sizing", () => {
    function container(
        metadata: CanvasGroup["metadata"],
        width: number | null = null,
        height: number | null = null
    ): CanvasGroup {
        return {
            id: "g1",
            canvas_id: "c1",
            name: "Container",
            type: "custom",
            positionX: 0,
            positionY: 0,
            width,
            height,
            metadata
        };
    }

    const gridOf = (cols: number) => ({ layout: "grid" as const, gridCols: cols });

    describe("manualFloorOf", () => {
        it("is zero until the user resizes", () => {
            expect(manualFloorOf(container(gridOf(3)))).toEqual({
                width: 0,
                height: 0
            });
        });

        it("reads the stored floor, not the rendered size", () => {
            const group = container(
                { ...gridOf(3), manualWidth: 900, manualHeight: 700 },
                4000,
                3000
            );
            expect(manualFloorOf(group)).toEqual({ width: 900, height: 700 });
        });
    });

    describe("resolveContainerDims", () => {
        it("falls back to the default container size when never resized", () => {
            expect(resolveContainerDims(container({}), { width: 0, height: 0 })).toEqual({
                width: DEFAULT_GROUP_WIDTH,
                height: DEFAULT_GROUP_HEIGHT
            });
        });

        it("honours a manual floor smaller than the default", () => {
            expect(
                resolveContainerDims(container({ manualWidth: 250, manualHeight: 160 }), {
                    width: 0,
                    height: 0
                })
            ).toEqual({ width: 250, height: 160 });
        });

        it("never goes below the resize clamp", () => {
            expect(
                resolveContainerDims(container({ manualWidth: 10, manualHeight: 10 }), {
                    width: 0,
                    height: 0
                })
            ).toEqual({ width: MIN_GROUP_WIDTH, height: MIN_GROUP_HEIGHT });
        });

        it("lets content that does not fit the manual floor widen it (design §6)", () => {
            expect(
                resolveContainerDims(container({ manualWidth: 500, manualHeight: 500 }), {
                    width: 1200,
                    height: 300
                })
            ).toEqual({ width: 1200, height: 500 });
        });

        it("ignores the container's own current size", () => {
            // The ratchet, stated as a property: a container stored at 4000px
            // with a 500px floor and 600px of content resolves to 600, not 4000.
            expect(
                resolveContainerDims(
                    container({ manualWidth: 500, manualHeight: 500 }, 4000, 4000),
                    { width: 600, height: 600 }
                )
            ).toEqual({ width: 600, height: 600 });
        });
    });

    describe("resolveGridDims", () => {
        it("round-trips grow-then-shrink back to the manual floor", () => {
            for (const layout of LAYOUTS) {
                const floor = gridDimensions(1, 5, layout);
                const group = container({
                    ...gridOf(3),
                    manualWidth: floor.width,
                    manualHeight: floor.height
                });

                // A Bo5 arrives: six columns, two rows. Content wins.
                const grown = resolveGridDims(group, 2, 6, layout);
                expect(grown).toEqual(gridDimensions(2, 6, layout));

                // It leaves. Back to the user's width, NOT the grown one.
                const shrunk = resolveGridDims(
                    container({
                        ...gridOf(3),
                        manualWidth: floor.width,
                        manualHeight: floor.height
                    }),
                    1,
                    3,
                    layout
                );
                expect(shrunk).toEqual(floor);
                expect(shrunk.width).toBeLessThan(grown.width);
            }
        });

        it("never undoes a manual resize when content changes", () => {
            const layout: CardLayout = "wide";
            const floor = gridDimensions(4, 6, layout);
            const group = container({
                ...gridOf(3),
                manualWidth: floor.width,
                manualHeight: floor.height
            });
            // One card in a 3-column grid: far smaller than the floor.
            expect(resolveGridDims(group, 1, 3, layout)).toEqual(floor);
        });

        it("returns effectiveGridCols to its pre-drop value once a wide child leaves", () => {
            const layout: CardLayout = "wide";
            const metadata = gridOf(3);

            const before = resolveGridDims(container(metadata), 1, 3, layout);
            const beforeCols = effectiveGridCols(
                container(metadata, before.width, before.height),
                layout,
                0
            );
            expect(beforeCols).toBe(4); // 3 configured + the growth column

            // A Bo5 (6 columns wide) is dropped in.
            const grown = resolveGridDims(container(metadata), 2, 6, layout);
            expect(
                effectiveGridCols(
                    container(metadata, grown.width, grown.height),
                    layout,
                    SPAN6.cols
                )
            ).toBe(6);

            // It is dragged back out: cols fall back to the configured count,
            // the width follows, and so does effectiveGridCols.
            const after = resolveGridDims(container(metadata), 1, 3, layout);
            expect(after).toEqual(before);
            expect(
                effectiveGridCols(
                    container(metadata, after.width, after.height),
                    layout,
                    0
                )
            ).toBe(beforeCols);
        });
    });

    describe("contentBoundsOf", () => {
        it("reports no bounds and an unbounded left edge when empty", () => {
            expect(contentBoundsOf([])).toEqual({
                width: 0,
                height: 0,
                maxLeftEdgeDelta: Infinity,
                expandLeft: 0
            });
        });

        it("unions child rects and adds padding on the right and bottom", () => {
            expect(
                contentBoundsOf([
                    { x: 16, y: 16, width: 100, height: 50 },
                    { x: 200, y: 40, width: 100, height: 300 }
                ])
            ).toEqual({
                width: 300 + GRID_PADDING,
                height: 340 + GRID_PADDING,
                maxLeftEdgeDelta: 0,
                expandLeft: 0
            });
        });

        it("reports how far the left edge must move OUT for a child past it", () => {
            const bounds = contentBoundsOf([{ x: -34, y: 0, width: 10, height: 10 }]);
            expect(bounds.expandLeft).toBe(GRID_PADDING + 34);
            // Mirror images: exactly one of the two is ever nonzero.
            expect(bounds.maxLeftEdgeDelta).toBe(0);
        });

        it("measures how far the left edge may travel before it crosses a child", () => {
            expect(
                contentBoundsOf([{ x: 116, y: 0, width: 10, height: 10 }])
                    .maxLeftEdgeDelta
            ).toBe(100);
        });

        it("never reports a negative left-edge budget for a child outside the frame", () => {
            expect(
                contentBoundsOf([{ x: -400, y: 0, width: 10, height: 10 }])
                    .maxLeftEdgeDelta
            ).toBe(0);
        });
    });
});
