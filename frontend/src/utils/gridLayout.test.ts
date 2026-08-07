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
    rectCells,
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
    footprintPixelSize,
    MIN_GROUP_WIDTH,
    MIN_GROUP_HEIGHT,
    DEFAULT_GROUP_WIDTH,
    DEFAULT_GROUP_HEIGHT,
    type GridFootprint,
    type GridItem
} from "./gridLayout";
import { cardWidth, cardHeight } from "./helpers";
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

// Minimal GridItem factory. `id` is the node's PLACEMENT identity — a Card's
// draft_id, a Group's id — which is what canvasTree.gridItemsOf emits.
function itemAt(
    id: string,
    x: number,
    y: number,
    layout: CardLayout,
    cols: number,
    footprint: GridFootprint = CARD_FOOTPRINT,
    kind: GridItem["kind"] = "card"
): GridItem {
    return {
        id,
        kind,
        footprint,
        position: { x, y },
        cell: positionToCell(x, y, layout, cols)
    };
}

function itemInCell(
    id: string,
    row: number,
    col: number,
    layout: CardLayout,
    footprint: GridFootprint = CARD_FOOTPRINT,
    kind: GridItem["kind"] = "card"
): GridItem {
    const pos = cellToPosition({ row, col }, layout);
    return {
        id,
        kind,
        footprint,
        position: { x: pos.x, y: pos.y },
        cell: { row, col }
    };
}

const cellOf = (
    placement: { positionX: number; positionY: number },
    layout: CardLayout,
    cols: number
) => positionToCell(placement.positionX, placement.positionY, layout, cols);

// A Bo3 series and a Bo5 series, as canvasTree.footprintOf derives them.
const BO3: GridFootprint = { rows: 2, cols: 4 };
const BO5: GridFootprint = { rows: 2, cols: 6 };

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

describe("rectCells", () => {
    it("covers every cell of a footprint, not just its top-left", () => {
        expect(rectCells({ row: 1, col: 2 }, { rows: 2, cols: 3 })).toEqual([
            { row: 1, col: 2 },
            { row: 1, col: 3 },
            { row: 1, col: 4 },
            { row: 2, col: 2 },
            { row: 2, col: 3 },
            { row: 2, col: 4 }
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
        const items = [itemInCell("s", 0, 0, "wide", BO3, "group")];
        expect(firstEmptyRect(items, CARD_FOOTPRINT, 6)).toEqual({ row: 0, col: 4 });
    });

    it("finds the first cell where the WHOLE footprint fits", () => {
        // One Card at (0,0). A Bo3 needs 4 free columns across 2 rows, so it
        // cannot start at (0,0), and in a 5-column grid the only other legal
        // start on row 0 is (0,1) — cols 1-4, clear of the card.
        const items = [itemInCell("a", 0, 0, "wide")];
        expect(firstEmptyRect(items, BO3, 5)).toEqual({ row: 0, col: 1 });
    });

    it("drops to the next row when no start column on this one fits", () => {
        const items = [itemInCell("a", 0, 1, "wide")];
        // Legal starts in a 5-column grid are cols 0 and 1; both cover (0,1).
        expect(firstEmptyRect(items, BO3, 5)).toEqual({ row: 1, col: 0 });
    });

    it("terminates on a footprint wider than the grid instead of scanning forever", () => {
        // copyPlacement calls this with the CONFIGURED column count, which can
        // be narrower than a child. Clamping to column 0 overhangs; not
        // clamping never finds a legal column at all.
        expect(firstEmptyRect([], BO5, 3)).toEqual({ row: 0, col: 0 });
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

describe("resolveGridDrop", () => {
    const draggedCard = (id: string) => ({
        id,
        kind: "card" as const,
        footprint: CARD_FOOTPRINT
    });

    it("snaps into an empty cell: one placement, no swap", () => {
        const a = itemInCell("a", 0, 0, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = resolveGridDrop({
            items: [a, itemAt("dragged", target.x + 30, target.y - 10, "wide", 3)],
            dragged: draggedCard("dragged"),
            draggedOrigin: null,
            dropX: target.x + 30,
            dropY: target.y - 10,
            layout: "wide",
            cols: 3
        });
        expect(placements).toEqual([
            {
                id: "dragged",
                kind: "card",
                positionX: target.x,
                positionY: target.y
            }
        ]);
    });

    it("swap with origin: occupant moves to the dragged card's origin cell", () => {
        const origin = cellToPosition({ row: 1, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const occupant = itemInCell("occ", 0, 0, "wide");
        const dragged = itemAt("dragged", target.x + 5, target.y + 5, "wide", 3);
        const placements = resolveGridDrop({
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
            positionX: target.x,
            positionY: target.y
        });
        expect(placements).toContainEqual({
            id: "occ",
            kind: "card",
            positionX: origin.x,
            positionY: origin.y
        });
    });

    it("swap without origin (card entering from outside): occupant moves to first empty cell", () => {
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const empty = cellToPosition({ row: 0, col: 1 }, "wide");
        const occupant = itemInCell("occ", 0, 0, "wide");
        const placements = resolveGridDrop({
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
            positionX: empty.x,
            positionY: empty.y
        });
    });

    it("refuses to swap a 1x1 with a 2x4: the dragged card takes the nearest free rect", () => {
        // Decision 7: swap survives only for 1x1 <-> 1x1. Evicting a whole
        // series because a Card landed on one of its eight cells is the
        // failure mode this rule exists to prevent.
        const series = itemInCell("bo3", 0, 0, "wide", BO3, "group");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = resolveGridDrop({
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
        // (0,1) — two rows straight down, not three columns across.
        expect(cellOf(placements[0], "wide", 6)).toEqual({ row: 2, col: 1 });
    });

    it("relocates a wide dragged node rather than displacing the card it lands on", () => {
        const card = itemInCell("a", 0, 0, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const placements = resolveGridDrop({
            items: [card],
            dragged: { id: "bo3", kind: "group", footprint: BO3 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(placements.map((p) => p.id)).toEqual(["bo3"]);
        // A Bo3 needs 4 free columns across 2 rows; (0,1) collides with nothing
        // but overhangs (cols 1-4 of 6 is fine), so it lands there.
        expect(cellOf(placements[0], "wide", 6)).toEqual({ row: 0, col: 1 });
    });

    it("clamps the target so a wide footprint cannot overhang the last column", () => {
        const target = cellToPosition({ row: 0, col: 5 }, "wide");
        const placements = resolveGridDrop({
            items: [],
            dragged: { id: "bo3", kind: "group", footprint: BO3 },
            draggedOrigin: null,
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 6
        });
        expect(cellOf(placements[0], "wide", 6)).toEqual({ row: 0, col: 2 });
    });
});

describe("kind-gated swap (decision 7, amended round 2)", () => {
    it("swaps two 1x1 CARDS, as before", () => {
        const occupant = itemInCell("occupant", 0, 1, "wide");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = resolveGridDrop({
            items: [occupant],
            dragged: { id: "dragged", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x,
            dropY: target.y,
            layout: "wide",
            cols: 3
        });
        expect(placements).toHaveLength(2);
        expect(cellOf(placements[1], "wide", 3)).toEqual({ row: 0, col: 0 });
    });

    // A default 400x200 Group is 1x1 in four of the six layouts, so `isUnit`
    // alone made the swap layout-dependent — and cardLayout is canvas-level and
    // broadcast, so one user's display toggle changed everyone's drop gesture.
    it("never evicts a 1x1 GROUP; the dragged Card relocates instead", () => {
        const occupant = itemInCell("nested", 0, 1, "wide", CARD_FOOTPRINT, "group");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = resolveGridDrop({
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
        expect(cellOf(placements[0], "wide", 3)).not.toEqual({ row: 0, col: 1 });
    });

    it("never lets a 1x1 GROUP evict a Card either", () => {
        const occupant = itemInCell("card", 0, 1, "wide");
        const origin = cellToPosition({ row: 0, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const placements = resolveGridDrop({
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
        const placements = arrangeGrid(items, "wide", 3);
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        expect(placements.find((u) => u.id === "a")).toEqual({
            id: "a",
            kind: "card",
            positionX: p.x,
            positionY: p.y
        });
    });

    it("resolves two items nearest the same cell: second goes to next empty cell in reading order", () => {
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        const items = [
            itemAt("a", p.x + 5, p.y + 5, "wide", 3),
            itemAt("b", p.x + 40, p.y + 40, "wide", 3)
        ];
        const cells = arrangeGrid(items, "wide", 3).map((u) => cellOf(u, "wide", 3));
        expect(cells).toContainEqual({ row: 0, col: 0 });
        expect(cells).toContainEqual({ row: 0, col: 1 });
    });

    // Converting an EMPTY group to grid is a real user action ("Arrange as
    // grid" on a group with no cards), and it produces no position updates at
    // all — the whole request is carried by the group's dims + metadata. The
    // backend guard used to reject that as "positions must be a non-empty
    // array", so the conversion silently failed to persist behind an
    // optimistic store write.
    it("returns no placements for an empty group, leaving the group to carry the work", () => {
        const placements = arrangeGrid([], "wide", 3);
        expect(placements).toEqual([]);

        const rows = rowCountAfter(placements, [], "wide", 3);
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
            arrangeGrid(items, "compact", 3).map((u) => {
                const c = cellOf(u, "compact", 3);
                return `${c.row}:${c.col}`;
            })
        );
        expect(keys.size).toBe(7);
    });

    it("packs rectangles without overlap, keeping the series atomic", () => {
        const items = [
            itemInCell("bo3", 0, 0, "wide", BO3, "group"),
            itemInCell("a", 0, 1, "wide"),
            itemInCell("b", 0, 2, "wide")
        ];
        const placements = arrangeGrid(items, "wide", 6);
        const cells = new Map(placements.map((p) => [p.id, cellOf(p, "wide", 6)]));
        expect(cells.get("bo3")).toEqual({ row: 0, col: 0 });
        // Both cards are pushed clear of the series' 2x4 block.
        const covered = new Set(
            rectCells({ row: 0, col: 0 }, BO3).map((c) => `${c.row}:${c.col}`)
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
            itemInCell("series", 0, 0, "wide", BO5, "group"),
            itemInCell("card", 0, 4, "wide")
        ];
        const placements = reflowAfterGrowth({
            items,
            grownId: "series",
            layout: "wide",
            cols: 6
        });
        // The grown node does not move, so it produces no placement.
        expect(placements.map((p) => p.id)).toEqual(["card"]);
        const cell = cellOf(placements[0], "wide", 6);
        const covered = new Set(
            rectCells({ row: 0, col: 0 }, BO5).map((c) => `${c.row}:${c.col}`)
        );
        expect(covered.has(`${cell.row}:${cell.col}`)).toBe(false);
        // Nearest free rect from (0,4) is straight down, out of the series.
        expect(cell).toEqual({ row: 2, col: 4 });
    });

    it("grows a resized nested Group right/down rather than relocating it", () => {
        const items = [
            itemInCell("child", 1, 1, "wide", { rows: 2, cols: 2 }, "group"),
            itemInCell("a", 1, 2, "wide"),
            itemInCell("b", 3, 0, "wide")
        ];
        const placements = reflowAfterGrowth({
            items,
            grownId: "child",
            layout: "wide",
            cols: 4
        });
        // "b" is clear of the grown rect, so it is untouched; only "a" moves.
        expect(placements.map((p) => p.id)).toEqual(["a"]);
        expect(cellOf(placements[0], "wide", 4)).toEqual({ row: 0, col: 2 });
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
            layout: "compact",
            cols: 3
        });
        const cells = new Map(items.map((i) => [i.id, `${i.cell.row}:${i.cell.col}`]));
        for (const p of placements) {
            const c = cellOf(p, "compact", 3);
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
                layout: "wide",
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

describe("footprintPixelSize", () => {
    it("is exactly one card for a unit footprint, in every layout", () => {
        for (const layout of LAYOUTS) {
            expect(footprintPixelSize(CARD_FOOTPRINT, layout)).toEqual({
                width: cardWidth(layout),
                height: cardHeight(layout)
            });
        }
    });

    it("puts the gaps INSIDE the span, inverting spanFor", () => {
        const size = footprintPixelSize(BO3, "wide");
        expect(size.width).toBe(4 * cardWidth("wide") + 3 * GRID_CELL_GAP);
        expect(size.height).toBe(2 * cardHeight("wide") + 1 * GRID_CELL_GAP);
    });

    it("clamps a degenerate footprint to one cell", () => {
        expect(footprintPixelSize({ rows: 0, cols: 0 }, "wide")).toEqual({
            width: cardWidth("wide"),
            height: cardHeight("wide")
        });
    });
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

    it("counts the bottom row of a footprint, not its top", () => {
        const series = itemInCell("bo3", 1, 0, "wide", BO3, "group");
        expect(rowCountAfter([], [series], "wide", 6)).toBe(3);
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
        expect(effectiveGridCols(gridGroup(3, null), "wide", BO5.cols)).toBe(6);
    });

    it("effectiveGridCols keeps the growth column when no child dominates", () => {
        expect(effectiveGridCols(gridGroup(3, null), "wide", 1)).toBe(4);
    });

    it("resolveGridDrop lands in a growth column when cols allow it", () => {
        const a = itemInCell("a", 0, 2, "wide");
        const target = cellToPosition({ row: 0, col: 3 }, "wide");
        const placements = resolveGridDrop({
            items: [a],
            dragged: { id: "dragged", kind: "card", footprint: CARD_FOOTPRINT },
            draggedOrigin: null,
            dropX: target.x + 10,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(placements).toEqual([
            {
                id: "dragged",
                kind: "card",
                positionX: target.x,
                positionY: target.y
            }
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
        expect(arrangedRowCount([], "wide", 3)).toBe(1);
    });

    it("reflects spread-out ideal rows, not ceil(count / cols)", () => {
        // Items whose positions sit at rows 0 and 3. arrangeGrid preserves the
        // ideal row, so the grid spans 4 rows even though ceil(2/3) === 1.
        const items = [itemInCell("a", 0, 0, "wide"), itemInCell("b", 3, 1, "wide")];
        expect(arrangedRowCount(items, "wide", 3)).toBe(4);
    });

    it("counts collision overflow into later rows", () => {
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        const items = Array.from({ length: 4 }, (_, i) =>
            itemAt(`d${i}`, p.x + i, p.y + i, "wide", 1)
        );
        // cols=1 forces the four near-(0,0) items into rows 0..3.
        expect(arrangedRowCount(items, "wide", 1)).toBe(4);
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
                    BO5.cols
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
