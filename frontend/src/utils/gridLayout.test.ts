import { describe, it, expect } from "vitest";
import {
    GRID_CELL_GAP,
    GRID_PADDING,
    GRID_HEADER_HEIGHT,
    CARD_FOOTPRINT,
    cellToPosition,
    firstEmptyRect,
    nearestFreeRect,
    rectCells,
    resolveGridDrop,
    reflowAfterGrowth,
    arrangeGrid,
    gridDimensions,
    colsFromWidth,
    effectiveGridCols,
    configuredColsAfterDrop,
    configuredRowsAfterDrop,
    mergeLabels,
    buildGridMetadata,
    arrangedRowCount,
    resolveGridSave,
    resolveResizeGridSettings,
    gridMetadataEquals,
    DEFAULT_GRID_COLS,
    DEFAULT_GRID_ROWS,
    toPositionUpdates,
    manualFloorOf,
    resolveContainerDims,
    resolveGridDims,
    contentBoundsOf,
    annotationContentRectsOf,
    footprintPixelWidth,
    MIN_GROUP_WIDTH,
    MIN_GROUP_HEIGHT,
    DEFAULT_GROUP_WIDTH,
    DEFAULT_GROUP_HEIGHT,
    cellAt,
    colAt,
    materializeGrid,
    rowsOfItems,
    type GridAssignment,
    type GridCell,
    type GridFootprint,
    type GridItem
} from "./gridLayout";
import {
    gridContentHeight,
    gridContentHeightForRows,
    memberY,
    rowAtY,
    rowsOfIndexed
} from "./gridRows";
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
        [
            {
                id: "x",
                index: cell.row,
                inset: chrome.inset,
                height: chrome.height,
                sizesRow: true,
                rowSpan: 1
            }
        ],
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
        cell: {
            row: rowAtY(
                rowsOfIndexed(
                    [
                        {
                            id,
                            index: 0,
                            inset: chrome.inset,
                            height: chrome.height,
                            sizesRow: true,
                            rowSpan: 1
                        }
                    ],
                    layout
                ),
                y,
                layout
            ),
            col: colAt(x, layout, cols)
        },
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
            height: chromeOf(spec).height,
            sizesRow: true,
            rowSpan: 1
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
            height: chrome.height,
            sizesRow: true
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
const SPAN4: GridFootprint = { cols: 4, rows: 1 };
const SPAN6: GridFootprint = { cols: 6, rows: 1 };

// `positionToCell` is gone: the row half can no longer be a division, because
// rows have different heights. `cellAt` needs the actual bands. On an EMPTY
// container the bands are uniform again, which is what keeps these assertions
// meaningful — they are the parity check against the retired inverse.
describe("cell math", () => {
    it("round-trips cell -> position -> cell for every layout", () => {
        for (const layout of LAYOUTS) {
            for (const cell of [
                { row: 0, col: 0 },
                { row: 2, col: 1 },
                { row: 5, col: 2 }
            ]) {
                const pos = cellToPosition(cell, layout);
                expect(cellAt([], pos.x, pos.y, layout, 3)).toEqual(cell);
            }
        }
    });

    it("snaps a position offset by less than half a cell back to the same cell", () => {
        const pos = cellToPosition({ row: 1, col: 1 }, "wide");
        expect(cellAt([], pos.x + 100, pos.y - 100, "wide", 3)).toEqual({
            row: 1,
            col: 1
        });
    });

    it("clamps col into [0, cols-1] and row to >= 0", () => {
        expect(cellAt([], -500, -500, "wide", 3)).toEqual({ row: 0, col: 0 });
        expect(cellAt([], 99999, 0, "wide", 3).col).toBe(2);
    });
});

describe("rectCells", () => {
    it("covers one row and `cols` columns", () => {
        expect(rectCells({ row: 2, col: 1 }, { cols: 3, rows: 1 })).toEqual([
            { row: 2, col: 1 },
            { row: 2, col: 2 },
            { row: 2, col: 3 }
        ]);
    });

    it("never covers a second row — the row grows instead", () => {
        expect(
            rectCells({ row: 0, col: 0 }, { cols: 5, rows: 1 }).every((c) => c.row === 0)
        ).toBe(true);
    });

    it("clamps a zero or negative span to one column", () => {
        expect(rectCells({ row: 0, col: 0 }, { cols: 0, rows: 1 })).toEqual([
            { row: 0, col: 0 }
        ]);
        expect(rectCells({ row: 0, col: 0 }, { cols: -3, rows: 1 })).toEqual([
            { row: 0, col: 0 }
        ]);
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
            { cols: games, rows: 1 },
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
                    footprint: { cols: 3, rows: 1 },
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
            { cols: 3, rows: 1 },
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

    // D6a: the champion-pool Group is every cell an annotation. Without the
    // leaf gate it can never be reordered — every drag flings the note to the
    // nearest free cell.
    it("swaps annotation onto annotation", () => {
        const items = itemsInCells(
            [
                { id: "a1", cell: { row: 0, col: 0 }, kind: "annotation" },
                { id: "a2", cell: { row: 0, col: 1 }, kind: "annotation" }
            ],
            "wide"
        );
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const result = drop({
            items,
            dragged: { id: "a1", kind: "annotation", footprint: CARD_FOOTPRINT },
            draggedOrigin: items[0].position,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(result).toEqual([
            { id: "a1", kind: "annotation", cell: { row: 0, col: 1 } },
            { id: "a2", kind: "annotation", cell: { row: 0, col: 0 } }
        ]);
    });

    it("swaps annotation onto Card", () => {
        const annotationChrome = { inset: CARD_INSET, height: 120 };
        const items = itemsInCells(
            [
                {
                    id: "a1",
                    cell: { row: 0, col: 0 },
                    kind: "annotation",
                    chrome: annotationChrome
                },
                {
                    id: "d1",
                    cell: { row: 0, col: 1 },
                    kind: "card",
                    chrome: cardChrome("wide")
                }
            ],
            "wide"
        );
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const result = drop({
            items,
            dragged: { id: "a1", kind: "annotation", footprint: CARD_FOOTPRINT },
            draggedOrigin: items[0].position,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(result).toEqual([
            { id: "a1", kind: "annotation", cell: { row: 0, col: 1 } },
            { id: "d1", kind: "card", cell: { row: 0, col: 0 } }
        ]);
    });

    it("swaps Card onto annotation", () => {
        const annotationChrome = { inset: CARD_INSET, height: 120 };
        const items = itemsInCells(
            [
                {
                    id: "d1",
                    cell: { row: 0, col: 0 },
                    kind: "card",
                    chrome: cardChrome("wide")
                },
                {
                    id: "a1",
                    cell: { row: 0, col: 1 },
                    kind: "annotation",
                    chrome: annotationChrome
                }
            ],
            "wide"
        );
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const result = drop({
            items,
            dragged: { id: "d1", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: items[0].position,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(result).toEqual([
            { id: "d1", kind: "card", cell: { row: 0, col: 1 } },
            { id: "a1", kind: "annotation", cell: { row: 0, col: 0 } }
        ]);
    });

    // The gate's original rationale, unchanged: a container is never evicted.
    it("still refuses to evict a Group for an annotation", () => {
        const items = itemsInCells(
            [
                { id: "a1", cell: { row: 0, col: 0 }, kind: "annotation" },
                { id: "g1", cell: { row: 0, col: 1 }, kind: "group" }
            ],
            "wide"
        );
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const result = drop({
            items,
            dragged: { id: "a1", kind: "annotation", footprint: CARD_FOOTPRINT },
            draggedOrigin: items[0].position,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(result).toEqual([
            { id: "a1", kind: "annotation", cell: { row: 0, col: 0 } }
        ]);
    });

    // The kind half is not redundant with the footprint half: a 2-column
    // annotation is a leaf, and the swap needs CONGRUENT footprints. This
    // fixture drops a 2×1 onto a 1×1, so it stays a no-swap under the congruence
    // rule that replaced the old "both exactly one cell" test — but two 2×1
    // notes now DO swap, which the next test pins.
    it("does not swap a 2-column annotation onto a 1-column one", () => {
        const items = itemsInCells(
            [
                {
                    id: "a-wide",
                    cell: { row: 0, col: 0 },
                    footprint: { cols: 2, rows: 1 },
                    kind: "annotation"
                },
                { id: "a1", cell: { row: 0, col: 2 }, kind: "annotation" }
            ],
            "wide"
        );
        const target = cellToPosition({ row: 0, col: 2 }, "wide");
        const result = drop({
            items,
            dragged: {
                id: "a-wide",
                kind: "annotation",
                footprint: { cols: 2, rows: 1 }
            },
            draggedOrigin: items[0].position,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 4
        });
        expect(result).toEqual([
            { id: "a-wide", kind: "annotation", cell: { row: 1, col: 2 } }
        ]);
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

        const dims = gridDimensions(gridContentHeight([]), 3, "wide");
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
            rectCells({ row: 0, col: 0 }, SPAN4).map((c: GridCell) => `${c.row}:${c.col}`)
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
            rectCells({ row: 0, col: 0 }, SPAN6).map((c: GridCell) => `${c.row}:${c.col}`)
        );
        expect(covered.has(`${cell.row}:${cell.col}`)).toBe(false);
        // Nearest free rect from (0,4) is straight down, out of the series —
        // one row, not two, now that a series claims only its own row.
        expect(cell).toEqual({ row: 1, col: 4 });
    });

    it("grows a resized nested Group right/down rather than relocating it", () => {
        const items = [
            itemInCell("child", 1, 1, "wide", { cols: 2, rows: 1 }, "group"),
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

    // `toPositionUpdates` filters to Cards. That was TOTAL while only Cards
    // could be in a grid and silently lossy the moment a Group could be — the
    // exact bug gridPersistence.ts was created to fix. An annotation is the
    // third kind walking into the same filter.
    it("drops annotation placements, deliberately and visibly", () => {
        expect(
            toPositionUpdates([
                { id: "d1", kind: "card", positionX: 0, positionY: 0 },
                { id: "a1", kind: "annotation", positionX: 10, positionY: 10 },
                { id: "g1", kind: "group", positionX: 20, positionY: 20 }
            ])
        ).toEqual([{ draft_id: "d1", positionX: 0, positionY: 0 }]);
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
        expect(footprintPixelWidth({ cols: 0, rows: 1 }, "wide")).toBe(cardWidth("wide"));
    });

    // There is deliberately no height half. A row's height is a property of
    // its MEMBERSHIP (`gridRows.rowsOf`), not of any one footprint, so a
    // `rows * cardHeight` answer could only ever be wrong for the drop
    // highlight that consumes it.
});

describe("gridDimensions", () => {
    it("takes a CONTENT HEIGHT, and does not re-add the header or padding", () => {
        // gridContentHeight already includes header + both paddings. Adding
        // them again here is the one arithmetic trap in this signature.
        const rows = rowsOfItems(
            [itemInCell("a", 0, 0, "wide"), itemInCell("b", 1, 0, "wide")],
            "wide"
        );
        const dims = gridDimensions(gridContentHeight(rows), 3, "wide");
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

    // §6.0a's headline result, as container arithmetic: a Bo3 costs ONE row
    // band, not two, and that band is exactly as tall as the series paints.
    it("makes a lone Bo3 one row tall, not two", () => {
        const bo3 = itemInCell(
            "s",
            0,
            0,
            "wide",
            { cols: 3, rows: 1 },
            "group",
            seriesChrome(3, "wide")
        );
        const rows = rowsOfItems([bo3], "wide");
        expect(rows).toHaveLength(1);
        expect(gridDimensions(gridContentHeight(rows), 3, "wide").height).toBe(
            GRID_HEADER_HEIGHT +
                2 * GRID_PADDING +
                getSeriesGroupDimensions(3, "wide").height
        );
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

    describe("configuredColsAfterDrop", () => {
        it("is the configured count when the landing already fits", () => {
            expect(
                configuredColsAfterDrop(gridGroup(3, null), { row: 0, col: 0 }, SPAN4)
            ).toBe(4);
            expect(
                configuredColsAfterDrop(
                    gridGroup(5, null),
                    { row: 2, col: 1 },
                    CARD_FOOTPRINT
                )
            ).toBe(5);
        });

        it("counts to the last column the landing OCCUPIES, not to its start", () => {
            // A Bo3 is three columns. Landing at column 1 it covers 1, 2 and 3.
            expect(
                configuredColsAfterDrop(
                    gridGroup(3, null),
                    { row: 0, col: 1 },
                    { cols: 3, rows: 1 }
                )
            ).toBe(4);
            expect(
                configuredColsAfterDrop(gridGroup(3, null), { row: 0, col: 2 }, SPAN4)
            ).toBe(6);
        });

        it("still bumps by one for a Card, exactly as `col + 1` did", () => {
            for (const col of [0, 1, 2, 3, 7]) {
                expect(
                    configuredColsAfterDrop(
                        gridGroup(3, null),
                        { row: 0, col },
                        CARD_FOOTPRINT
                    )
                ).toBe(Math.max(3, col + 1));
            }
        });
    });

    /**
     * The row half of the same rule, missing until 2026-08-11. Columns have
     * persisted their growth since §6: drop past the configured count and
     * `gridCols` rises to cover it. Rows never did — so a Card dropped into the
     * growth row of a one-row grid was accepted and the container grew to hold
     * it, but `gridRows` stayed 1, and moving that Card away collapsed the
     * container back to one row. The row the user added did not survive.
     */
    describe("configuredRowsAfterDrop", () => {
        const rowGroup = (gridRows: number): CanvasGroup => ({
            ...gridGroup(3, null),
            metadata: { layout: "grid", gridCols: 3, gridRows }
        });

        it("is the configured count when the landing already fits", () => {
            expect(
                configuredRowsAfterDrop(rowGroup(3), { row: 0, col: 0 }, CARD_FOOTPRINT)
            ).toBe(3);
            expect(
                configuredRowsAfterDrop(rowGroup(3), { row: 2, col: 1 }, CARD_FOOTPRINT)
            ).toBe(3);
        });

        it("rises to cover a landing in the growth row — the reported defect", () => {
            expect(
                configuredRowsAfterDrop(rowGroup(1), { row: 1, col: 0 }, CARD_FOOTPRINT)
            ).toBe(2);
        });

        it("covers a landing several rows past the end", () => {
            for (const row of [0, 1, 2, 5]) {
                expect(
                    configuredRowsAfterDrop(rowGroup(2), { row, col: 0 }, CARD_FOOTPRINT)
                ).toBe(Math.max(2, row + 1));
            }
        });

        /**
         * ⚠️ THIS TEST PINNED THE OPPOSITE RULE until 2026-08-14. It asserted
         * "no footprint term, §6.0a rule 1: nothing spans rows", by checking
         * two landings agreed regardless of the member. That contract is gone
         * with row spanning, and the assertion it used could not have caught
         * the change anyway — it varied only `col`, so both sides moved
         * together whatever the rule was.
         *
         * Rewritten to pin the term itself: a one-row member is unchanged, and
         * a two-row member must persist the row it actually reaches.
         */
        it("counts a one-row member as reaching exactly its landing row", () => {
            expect(
                configuredRowsAfterDrop(rowGroup(1), { row: 1, col: 0 }, CARD_FOOTPRINT)
            ).toBe(2);
        });

        it("counts a spanning member down to its LAST row", () => {
            expect(
                configuredRowsAfterDrop(
                    rowGroup(1),
                    { row: 1, col: 0 },
                    { cols: 1, rows: 2 }
                )
            ).toBe(3);
            expect(
                configuredRowsAfterDrop(
                    rowGroup(1),
                    { row: 0, col: 0 },
                    { cols: 1, rows: 4 }
                )
            ).toBe(4);
        });

        it("reads the DEFAULT row count for a grid that never stored one", () => {
            const legacy: CanvasGroup = {
                ...gridGroup(3, null),
                metadata: { layout: "grid", gridCols: 3 }
            };
            expect(
                configuredRowsAfterDrop(legacy, { row: 0, col: 0 }, CARD_FOOTPRINT)
            ).toBe(DEFAULT_GRID_ROWS);
            expect(
                configuredRowsAfterDrop(legacy, { row: 3, col: 0 }, CARD_FOOTPRINT)
            ).toBe(4);
        });

        /**
         * The invariant the defect broke, stated in PIXELS because that is where
         * it was visible: the container is sized from the persisted count, so
         * that count has to cover the child's painted right edge.
         *
         * Browser-reproduced before the fix — `vertical`, a 3-column grid, a Bo3
         * dropped at column 1: container 1220px, series right edge 1608px, an
         * overflow of exactly one column. `landing.col + 1` persisted 3.
         */
        it("sizes a container that contains the child it just accepted", () => {
            for (const layout of LAYOUTS) {
                for (const span of [1, 2, 3, 4, 6]) {
                    for (const col of [0, 1, 2, 3]) {
                        const footprint: GridFootprint = { cols: span, rows: 1 };
                        const cols = configuredColsAfterDrop(
                            gridGroup(3, null),
                            { row: 0, col },
                            footprint
                        );
                        const right =
                            cellToPosition({ row: 0, col }, layout).x +
                            footprintPixelWidth(footprint, layout) +
                            GRID_PADDING;
                        expect(
                            gridDimensions(0, cols, layout).width
                        ).toBeGreaterThanOrEqual(right);
                    }
                }
            }
        });

        /**
         * It can never exceed the layout count it resolved against, so a drop
         * cannot persist a grid wider than the lattice the user aimed at.
         * `clampToGrid` and `nearestFreeRectIn` both bound the landing column by
         * `lastStartCol(cols, footprint)`, which is exactly this statement.
         */
        it("never exceeds the layout count the drop resolved against", () => {
            for (const span of [1, 3, 4]) {
                const footprint: GridFootprint = { cols: span, rows: 1 };
                const layoutCols = Math.max(4, span);
                const lastStart = Math.max(0, layoutCols - span);
                expect(
                    configuredColsAfterDrop(
                        gridGroup(3, null),
                        { row: 0, col: lastStart },
                        footprint
                    )
                ).toBeLessThanOrEqual(layoutCols);
            }
        });
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
        gridRows: 2,
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
    const settings = {
        gridCols: 3,
        gridRows: 1,
        rowLabels: ["r"],
        colLabels: ["c1", "c2", "c3"]
    };

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

    it("does NOT reflow a row-count change — rows are a height floor", () => {
        // `arrangeGrid` never reads the row count, so reflowing on one would
        // relocate every member for a change that only resizes the frame.
        const { metadata, reflow } = resolveGridSave(
            { layout: "grid", gridCols: 3, gridRows: 1 },
            { ...settings, gridRows: 4 }
        );
        expect(reflow).toBe(false);
        expect(metadata.gridRows).toBe(4);
    });
});

/**
 * Lets an ordinary settings save — a rename, a classification change — stay ONE
 * request on a group whose grid nobody touched. Two partial metadata merges
 * fired from one save can have their responses arrive out of order, and the
 * loser replaces the row.
 */
describe("gridMetadataEquals", () => {
    const stored = {
        layout: "grid" as const,
        gridCols: 3,
        gridRows: 2,
        rowLabels: ["r1"],
        colLabels: ["c1"]
    };
    const asMetadata = (over: Partial<typeof stored> = {}) => ({
        ...stored,
        ...over,
        layout: "grid" as const
    });

    it("is true when nothing changed", () => {
        expect(gridMetadataEquals(stored, asMetadata())).toBe(true);
    });

    it("reads the same defaults gridColsOf and gridRowsOf do", () => {
        // A group that never stored a count must not be reported as changing
        // merely by having the default written down for the first time.
        expect(
            gridMetadataEquals(
                { layout: "grid", rowLabels: [], colLabels: [] },
                {
                    layout: "grid",
                    gridCols: DEFAULT_GRID_COLS,
                    gridRows: DEFAULT_GRID_ROWS,
                    rowLabels: [],
                    colLabels: []
                }
            )
        ).toBe(true);
    });

    it("is false for a layout, column, row or label change", () => {
        expect(gridMetadataEquals({ ...stored, layout: "free" }, asMetadata())).toBe(
            false
        );
        expect(gridMetadataEquals(stored, asMetadata({ gridCols: 4 }))).toBe(false);
        expect(gridMetadataEquals(stored, asMetadata({ gridRows: 3 }))).toBe(false);
        expect(gridMetadataEquals(stored, asMetadata({ rowLabels: ["x"] }))).toBe(false);
        expect(gridMetadataEquals(stored, asMetadata({ colLabels: ["x"] }))).toBe(false);
    });

    it("is false when a label array gains or loses an entry", () => {
        expect(gridMetadataEquals(stored, asMetadata({ colLabels: ["c1", ""] }))).toBe(
            false
        );
        expect(gridMetadataEquals(stored, asMetadata({ colLabels: [] }))).toBe(false);
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
        /** `n` uniform Card rows, as a CONTENT HEIGHT (§6.0a rule 2). */
        const cardRows = (n: number, layout: CardLayout) =>
            gridContentHeight(
                rowsOfItems(
                    Array.from({ length: n }, (_, i) =>
                        itemInCell(`r${i}`, i, 0, layout)
                    ),
                    layout
                )
            );

        it("round-trips grow-then-shrink back to the manual floor", () => {
            for (const layout of LAYOUTS) {
                const floor = gridDimensions(cardRows(1, layout), 5, layout);
                const group = container({
                    ...gridOf(3),
                    manualWidth: floor.width,
                    manualHeight: floor.height
                });

                // A Bo5 arrives: six columns, two rows. Content wins.
                const grown = resolveGridDims(group, cardRows(2, layout), 6, layout);
                expect(grown).toEqual(gridDimensions(cardRows(2, layout), 6, layout));

                // It leaves. Back to the user's width, NOT the grown one.
                const shrunk = resolveGridDims(
                    container({
                        ...gridOf(3),
                        manualWidth: floor.width,
                        manualHeight: floor.height
                    }),
                    cardRows(1, layout),
                    3,
                    layout
                );
                expect(shrunk).toEqual(floor);
                expect(shrunk.width).toBeLessThan(grown.width);
            }
        });

        it("never undoes a manual resize when content changes", () => {
            const layout: CardLayout = "wide";
            const floor = gridDimensions(cardRows(4, layout), 6, layout);
            const group = container({
                ...gridOf(3),
                manualWidth: floor.width,
                manualHeight: floor.height
            });
            // One card in a 3-column grid: far smaller than the floor.
            expect(resolveGridDims(group, cardRows(1, layout), 3, layout)).toEqual(floor);
        });

        it("returns effectiveGridCols to its pre-drop value once a wide child leaves", () => {
            const layout: CardLayout = "wide";
            const metadata = gridOf(3);

            const before = resolveGridDims(
                container(metadata),
                cardRows(1, layout),
                3,
                layout
            );
            const beforeCols = effectiveGridCols(
                container(metadata, before.width, before.height),
                layout,
                0
            );
            expect(beforeCols).toBe(4); // 3 configured + the growth column

            // A Bo5 (6 columns wide) is dropped in.
            const grown = resolveGridDims(
                container(metadata),
                cardRows(2, layout),
                6,
                layout
            );
            expect(
                effectiveGridCols(
                    container(metadata, grown.width, grown.height),
                    layout,
                    SPAN6.cols
                )
            ).toBe(6);

            // It is dragged back out: cols fall back to the configured count,
            // the width follows, and so does effectiveGridCols.
            const after = resolveGridDims(
                container(metadata),
                cardRows(1, layout),
                3,
                layout
            );
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

        it("a note past the frame widens the bounds like any other rect", () => {
            // The memo feeds annotation rects in with their STORED size; this is
            // the property that makes a container refuse to shrink past a note.
            expect(
                contentBoundsOf([
                    { x: 0, y: 0, width: 380, height: 600 },
                    { x: 400, y: 0, width: 380, height: 120 }
                ]).width
            ).toBe(796);
        });

        // D13: the champion-pool Group's contents are annotations and nothing else.
        it("derives real bounds from annotation rects alone", () => {
            const bounds = contentBoundsOf([
                { x: 0, y: 0, width: 380, height: 120 },
                { x: 0, y: 140, width: 380, height: 120 },
                { x: 0, y: 280, width: 380, height: 120 }
            ]);
            expect(bounds.width).toBe(396);
            expect(bounds.height).toBe(416);
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

        describe("annotationContentRectsOf", () => {
            it("collects each grouped annotation using its stored rect", () => {
                const rects = annotationContentRectsOf([
                    {
                        group_id: "pool",
                        positionX: 400,
                        positionY: 140,
                        width: 380,
                        height: 120
                    }
                ]);

                expect(rects.get("pool")).toEqual([
                    { x: 400, y: 140, width: 380, height: 120 }
                ]);
            });

            it("does not assign loose annotations to container contents", () => {
                expect(
                    annotationContentRectsOf([
                        {
                            group_id: null,
                            positionX: 400,
                            positionY: 140,
                            width: 380,
                            height: 120
                        }
                    ]).size
                ).toBe(0);
            });
        });
    });
});

/**
 * Resize → counts (2026-08-11). A manual resize used to write only the
 * `manualWidth`/`manualHeight` floor, leaving `gridCols` untouched — so the
 * width the user dragged and the width the column count implies were free to
 * disagree, and ANY later re-derivation reconciled them. A row-count edit was
 * the one that surfaced it: it moved the frame's WIDTH.
 *
 * The two were already contradicting each other elsewhere: `effectiveGridCols`
 * has always included `colsFromWidth`, so a container resized wider exposed
 * extra drop columns that the next re-derivation silently discarded.
 */
describe("resolveResizeGridSettings", () => {
    const layout: CardLayout = "vertical";

    const widthFor = (cols: number) => gridDimensions(0, cols, layout).width;

    it("reads the column count off the width the user dragged to", () => {
        for (const cols of [1, 2, 3, 5]) {
            expect(
                resolveResizeGridSettings({
                    width: widthFor(cols),
                    height: gridContentHeightForRows([], 1, layout),
                    rows: [],
                    layout
                }).gridCols
            ).toBe(cols);
        }
    });

    it("reads the row count off the height the user dragged to", () => {
        for (const rows of [1, 2, 4]) {
            expect(
                resolveResizeGridSettings({
                    width: widthFor(3),
                    height: gridContentHeightForRows([], rows, layout),
                    rows: [],
                    layout
                }).gridRows
            ).toBe(rows);
        }
    });

    /** The size a 1x1 grid needs — the smallest a grid container can honestly be. */
    const oneByOne = {
        width: widthFor(1),
        height: gridContentHeightForRows([], 1, layout)
    };

    /**
     * The property the whole fix rests on: the size these counts imply never
     * EXCEEDS the size the user dragged to, so `resolveContainerDims`' floor
     * (which is that same dragged size) always wins and the frame cannot snap
     * afterwards. Without it, resizing would set counts that immediately
     * resized the container away from where it was dropped.
     *
     * Swept from the 1x1 size up, because below it the one-row/one-column floor
     * has to win — see the test after this one.
     */
    it("never yields counts whose own size exceeds the dragged size", () => {
        for (let width = oneByOne.width; width < 2200; width += 37) {
            for (let height = oneByOne.height; height < 1800; height += 53) {
                const settings = resolveResizeGridSettings({
                    width,
                    height,
                    rows: [],
                    layout
                });
                const derived = gridDimensions(
                    gridContentHeightForRows([], settings.gridRows, layout),
                    settings.gridCols,
                    layout
                );
                // Equality is fine and common; only exceeding is a snap.
                expect(derived.width).toBeLessThanOrEqual(width);
                expect(derived.height).toBeLessThanOrEqual(height);
            }
        }
    });

    it("floors both counts at one, however small the container is dragged", () => {
        const settings = resolveResizeGridSettings({
            width: 0,
            height: 0,
            rows: [],
            layout
        });
        expect(settings).toEqual({ gridCols: 1, gridRows: 1 });
    });

    /**
     * The ONE case where a grid container still snaps after a resize, and it
     * predates this change: `MIN_GROUP_WIDTH`/`MIN_GROUP_HEIGHT` let the resize
     * handles go smaller than a single cell, and a grid cannot be narrower than
     * one column. Recorded rather than fixed — the clamp is shared with free
     * containers, which have no such floor.
     */
    it("documents the sub-one-cell floor the resize clamp still permits", () => {
        expect(MIN_GROUP_WIDTH).toBeLessThan(oneByOne.width);
        expect(MIN_GROUP_HEIGHT).toBeLessThan(oneByOne.height);
        const settings = resolveResizeGridSettings({
            width: MIN_GROUP_WIDTH,
            height: MIN_GROUP_HEIGHT,
            rows: [],
            layout
        });
        expect(settings).toEqual({ gridCols: 1, gridRows: 1 });
        expect(widthFor(settings.gridCols)).toBeGreaterThan(MIN_GROUP_WIDTH);
    });

    it("measures rows over the container's REAL bands, not a card lattice", () => {
        // A container holding a Bo3 has one tall row. Counting in card-height
        // steps would report two rows for a height that presents one.
        const tall = rowsOfIndexed(
            [{ id: "s", index: 0, inset: 172, height: 520, sizesRow: true, rowSpan: 1 }],
            layout
        );
        const height = gridContentHeightForRows(tall, 1, layout);
        expect(
            resolveResizeGridSettings({ width: widthFor(3), height, rows: tall, layout })
                .gridRows
        ).toBe(1);
    });
});

/**
 * Row spanning — the axis §6.0a rule 1 removed and the 2026-08-14 ruling
 * restored. Only annotations ever exceed one row, so every assertion here is
 * about a footprint no Card, series or nested Group can have; the proof that
 * they are unaffected is that every test above this block is untouched.
 */
describe("multi-row footprints", () => {
    const layout: CardLayout = "vertical";
    const TALL: GridFootprint = { cols: 1, rows: 2 };
    const WIDE_TALL: GridFootprint = { cols: 2, rows: 2 };

    describe("rectCells", () => {
        it("is identical to single-row stamping at rows: 1", () => {
            expect(rectCells({ row: 2, col: 1 }, { cols: 3, rows: 1 })).toEqual([
                { row: 2, col: 1 },
                { row: 2, col: 2 },
                { row: 2, col: 3 }
            ]);
        });

        it("stamps every cell of the rectangle, row-major", () => {
            expect(rectCells({ row: 1, col: 0 }, WIDE_TALL)).toEqual([
                { row: 1, col: 0 },
                { row: 1, col: 1 },
                { row: 2, col: 0 },
                { row: 2, col: 1 }
            ]);
        });

        it("floors a degenerate footprint at one cell", () => {
            expect(rectCells({ row: 0, col: 0 }, { cols: 0, rows: 0 })).toEqual([
                { row: 0, col: 0 }
            ]);
        });
    });

    describe("occupancy", () => {
        // A one-row item dropped on the spanning item's LOWER half must collide.
        // Under the old single-row stamping that cell was free, which is the
        // defect this whole axis exists to prevent.
        it("blocks a cell covered only by a spanning item's lower half", () => {
            const items = [itemInCell("note", 0, 0, layout, TALL, "annotation")];
            expect(firstEmptyRect(items, CARD_FOOTPRINT, 1)).toEqual({ row: 2, col: 0 });
        });

        it("leaves the neighbouring column of a covered row free", () => {
            const items = [itemInCell("note", 0, 0, layout, TALL, "annotation")];
            expect(firstEmptyRect(items, CARD_FOOTPRINT, 2)).toEqual({ row: 0, col: 1 });
        });

        // maxRow has to record the footprint's LAST row. Reading its first would
        // put the "free by construction" band across the item's own bottom half,
        // and every outward search is bounded by that promise.
        it("keeps the free band below a spanning item's BOTTOM row", () => {
            const items = [itemInCell("note", 3, 0, layout, TALL, "annotation")];
            const landing = nearestFreeRect(items, CARD_FOOTPRINT, { row: 4, col: 0 }, 1);
            expect(landing).not.toEqual({ row: 4, col: 0 });
            expect(landing).toEqual({ row: 5, col: 0 });
        });

        it("finds no room for a two-row footprint in a one-row hole", () => {
            const items = [
                itemInCell("a", 0, 0, layout, CARD_FOOTPRINT, "card"),
                itemInCell("b", 2, 0, layout, CARD_FOOTPRINT, "card")
            ];
            // Row 1 is free but a two-row stamp from it would hit row 2.
            expect(firstEmptyRect(items, TALL, 1)).toEqual({ row: 3, col: 0 });
        });

        it("takes a two-row hole when one exists", () => {
            const items = [
                itemInCell("a", 0, 0, layout, CARD_FOOTPRINT, "card"),
                itemInCell("b", 3, 0, layout, CARD_FOOTPRINT, "card")
            ];
            expect(firstEmptyRect(items, TALL, 1)).toEqual({ row: 1, col: 0 });
        });
    });

    describe("arrangeGrid", () => {
        it("does not let a reflow overlap a spanning item", () => {
            const items = [
                itemInCell("note", 0, 0, layout, TALL, "annotation"),
                itemInCell("card", 1, 0, layout, CARD_FOOTPRINT, "card")
            ];
            const assigned = arrangeGrid(items, 1);
            const note = assigned.find((a) => a.id === "note");
            const card = assigned.find((a) => a.id === "card");
            expect(note?.cell).toEqual({ row: 0, col: 0 });
            // Row 1 is inside the note, so the Card is pushed clear of it.
            expect(card?.cell).toEqual({ row: 2, col: 0 });
        });

        it("is unchanged when nothing spans", () => {
            const items = [
                itemInCell("a", 0, 0, layout, CARD_FOOTPRINT, "card"),
                itemInCell("b", 1, 0, layout, CARD_FOOTPRINT, "card")
            ];
            expect(arrangeGrid(items, 1).map((a) => a.cell)).toEqual([
                { row: 0, col: 0 },
                { row: 1, col: 0 }
            ]);
        });
    });
});

/**
 * Step 4 of row spanning: what a drop does when the two nodes are not the same
 * shape, and what a footprint growing DOWN displaces.
 */
describe("swapping and eviction across the row axis", () => {
    const layout: CardLayout = "vertical";
    const TALL: GridFootprint = { cols: 1, rows: 2 };

    const dropOnto = (
        items: GridItem[],
        dragged: { id: string; kind: GridItem["kind"]; footprint: GridFootprint },
        cell: GridCell,
        cols: number
    ) => {
        const origin = items.find((i) => i.id === dragged.id)?.position ?? null;
        const point = cellToPosition(cell, layout);
        return resolveGridDrop({
            items,
            rows: rowsOfItems(
                items.filter((i) => i.id !== dragged.id),
                layout
            ),
            dragged,
            draggedOrigin: origin,
            dropX: point.x,
            dropY: point.y,
            layout,
            cols
        });
    };

    it("refuses to swap a two-row note with a one-row Card", () => {
        const items = itemsInCells(
            [
                {
                    id: "note",
                    cell: { row: 0, col: 0 },
                    footprint: TALL,
                    kind: "annotation"
                },
                { id: "card", cell: { row: 2, col: 0 }, kind: "card" }
            ],
            layout
        );
        const result = dropOnto(
            items,
            { id: "note", kind: "annotation", footprint: TALL },
            { row: 2, col: 0 },
            1
        );
        // A swap would put the Card at row 0 and the note's second row on top of
        // it. Relocation instead: only the dragged node moves.
        expect(result.map((a) => a.id)).toEqual(["note"]);
        expect(result[0].cell).not.toEqual({ row: 2, col: 0 });
    });

    it("swaps two notes that are the same shape, however tall", () => {
        const items = itemsInCells(
            [
                {
                    id: "a",
                    cell: { row: 0, col: 0 },
                    footprint: TALL,
                    kind: "annotation"
                },
                { id: "b", cell: { row: 2, col: 0 }, footprint: TALL, kind: "annotation" }
            ],
            layout
        );
        const result = dropOnto(
            items,
            { id: "a", kind: "annotation", footprint: TALL },
            { row: 2, col: 0 },
            1
        );
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.id === "a")?.cell).toEqual({ row: 2, col: 0 });
        expect(result.find((r) => r.id === "b")?.cell).toEqual({ row: 0, col: 0 });
    });

    // The live behaviour change called out on `sameFootprint`: reachable today,
    // with no spanning involved at all.
    it("swaps two 2-column notes, which the old unit rule refused", () => {
        const wide: GridFootprint = { cols: 2, rows: 1 };
        const items = itemsInCells(
            [
                {
                    id: "a",
                    cell: { row: 0, col: 0 },
                    footprint: wide,
                    kind: "annotation"
                },
                { id: "b", cell: { row: 1, col: 0 }, footprint: wide, kind: "annotation" }
            ],
            layout
        );
        const result = dropOnto(
            items,
            { id: "a", kind: "annotation", footprint: wide },
            { row: 1, col: 0 },
            2
        );
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.id === "b")?.cell).toEqual({ row: 0, col: 0 });
    });

    it("still refuses to evict a container, whatever the shapes", () => {
        const items = itemsInCells(
            [
                { id: "g", cell: { row: 0, col: 0 }, kind: "group" },
                { id: "note", cell: { row: 1, col: 0 }, kind: "annotation" }
            ],
            layout
        );
        const result = dropOnto(
            items,
            { id: "note", kind: "annotation", footprint: CARD_FOOTPRINT },
            { row: 0, col: 0 },
            1
        );
        expect(result.map((a) => a.id)).toEqual(["note"]);
    });

    it("evicts the occupant of a row a footprint grows DOWN into", () => {
        // `reflowAfterGrowth` is footprint-generic, so the row axis needs no
        // special case — but nothing proved it until this ran.
        const items = itemsInCells(
            [
                {
                    id: "note",
                    cell: { row: 0, col: 0 },
                    footprint: TALL,
                    kind: "annotation"
                },
                { id: "card", cell: { row: 1, col: 0 }, kind: "card" }
            ],
            layout
        );
        const moved = reflowAfterGrowth({ items, grownId: "note", cols: 1 });
        expect(moved.map((a) => a.id)).toEqual(["card"]);
        expect(moved[0].cell).toEqual({ row: 2, col: 0 });
    });

    it("leaves a sibling alone when the growth misses it", () => {
        const items = itemsInCells(
            [
                {
                    id: "note",
                    cell: { row: 0, col: 0 },
                    footprint: TALL,
                    kind: "annotation"
                },
                { id: "card", cell: { row: 0, col: 1 }, kind: "card" }
            ],
            layout
        );
        expect(reflowAfterGrowth({ items, grownId: "note", cols: 2 })).toEqual([]);
    });
});
