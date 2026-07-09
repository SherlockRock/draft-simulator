import { describe, it, expect } from "vitest";
import {
    GRID_CELL_GAP,
    GRID_PADDING,
    GRID_HEADER_HEIGHT,
    cellToPosition,
    positionToCell,
    firstEmptyCell,
    resolveGridDrop,
    arrangeGrid,
    gridDimensions,
    rowCountAfter,
    colsFromWidth,
    effectiveGridCols
} from "./gridLayout";
import { cardWidth, cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";
import type { CanvasDraft, CanvasGroup } from "./schemas";

const LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

// Minimal CanvasDraft factory - only fields the grid math reads. NOTE:
// frontend CanvasDraft has NO top-level draft_id/id; identity is Draft.id.
function draftAt(id: string, x: number, y: number): CanvasDraft {
    return {
        positionX: x,
        positionY: y,
        is_locked: false,
        group_id: "g1",
        source_type: "canvas",
        Draft: {
            id,
            name: id,
            picks: Array(20).fill(""),
            type: "canvas"
        }
    };
}

function draftInCell(
    id: string,
    row: number,
    col: number,
    layout: CardLayout
): CanvasDraft {
    const pos = cellToPosition({ row, col }, layout);
    return draftAt(id, pos.x, pos.y);
}

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

describe("firstEmptyCell", () => {
    it("returns 0,0 for an empty group", () => {
        expect(firstEmptyCell([], "wide", 3)).toEqual({ row: 0, col: 0 });
    });

    it("skips occupied cells in reading order", () => {
        const drafts = [draftInCell("a", 0, 0, "wide"), draftInCell("b", 0, 1, "wide")];
        expect(firstEmptyCell(drafts, "wide", 3)).toEqual({ row: 0, col: 2 });
    });

    it("wraps to the next row when a row is full", () => {
        const drafts = [
            draftInCell("a", 0, 0, "wide"),
            draftInCell("b", 0, 1, "wide"),
            draftInCell("c", 0, 2, "wide")
        ];
        expect(firstEmptyCell(drafts, "wide", 3)).toEqual({ row: 1, col: 0 });
    });
});

describe("resolveGridDrop", () => {
    it("snaps into an empty cell: one update, no swap", () => {
        const a = draftInCell("a", 0, 0, "wide");
        const target = cellToPosition({ row: 0, col: 1 }, "wide");
        const updates = resolveGridDrop({
            groupDrafts: [a, draftAt("dragged", target.x + 30, target.y - 10)],
            draggedDraftId: "dragged",
            draggedOrigin: null,
            dropX: target.x + 30,
            dropY: target.y - 10,
            layout: "wide",
            cols: 3
        });
        expect(updates).toEqual([
            { draft_id: "dragged", positionX: target.x, positionY: target.y }
        ]);
    });

    it("swap with origin: occupant moves to the dragged card's origin cell", () => {
        const origin = cellToPosition({ row: 1, col: 0 }, "wide");
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const occupant = draftInCell("occ", 0, 0, "wide");
        const dragged = draftAt("dragged", target.x + 5, target.y + 5);
        const updates = resolveGridDrop({
            groupDrafts: [occupant, dragged],
            draggedDraftId: "dragged",
            draggedOrigin: { x: origin.x, y: origin.y },
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(updates).toContainEqual({
            draft_id: "dragged",
            positionX: target.x,
            positionY: target.y
        });
        expect(updates).toContainEqual({
            draft_id: "occ",
            positionX: origin.x,
            positionY: origin.y
        });
    });

    it("swap without origin (card entering from outside): occupant moves to first empty cell", () => {
        const target = cellToPosition({ row: 0, col: 0 }, "wide");
        const empty = cellToPosition({ row: 0, col: 1 }, "wide");
        const occupant = draftInCell("occ", 0, 0, "wide");
        const dragged = draftAt("dragged", target.x + 5, target.y + 5);
        const updates = resolveGridDrop({
            groupDrafts: [occupant, dragged],
            draggedDraftId: "dragged",
            draggedOrigin: null,
            dropX: target.x + 5,
            dropY: target.y + 5,
            layout: "wide",
            cols: 3
        });
        expect(updates).toContainEqual({
            draft_id: "occ",
            positionX: empty.x,
            positionY: empty.y
        });
    });
});

describe("arrangeGrid", () => {
    it("keeps already-tidy drafts in place", () => {
        const drafts = [draftInCell("a", 0, 0, "wide"), draftInCell("b", 0, 1, "wide")];
        const updates = arrangeGrid(drafts, "wide", 3);
        const a = updates.find((u) => u.draft_id === "a");
        expect(a).toEqual({
            draft_id: "a",
            ...(() => {
                const p = cellToPosition({ row: 0, col: 0 }, "wide");
                return { positionX: p.x, positionY: p.y };
            })()
        });
    });

    it("resolves two drafts nearest the same cell: second goes to next empty cell in reading order", () => {
        const p = cellToPosition({ row: 0, col: 0 }, "wide");
        const drafts = [draftAt("a", p.x + 5, p.y + 5), draftAt("b", p.x + 40, p.y + 40)];
        const updates = arrangeGrid(drafts, "wide", 3);
        const cells = updates.map((u) =>
            positionToCell(u.positionX, u.positionY, "wide", 3)
        );
        expect(cells).toContainEqual({ row: 0, col: 0 });
        expect(cells).toContainEqual({ row: 0, col: 1 });
    });

    it("assigns every draft a unique cell", () => {
        const drafts = Array.from({ length: 7 }, (_, i) =>
            draftAt(`d${i}`, 10 * i, 5 * i)
        );
        const updates = arrangeGrid(drafts, "compact", 3);
        const keys = new Set(
            updates.map((u) => {
                const c = positionToCell(u.positionX, u.positionY, "compact", 3);
                return `${c.row}:${c.col}`;
            })
        );
        expect(keys.size).toBe(7);
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
    it("counts rows from both pending updates and untouched drafts", () => {
        const settled = draftInCell("settled", 2, 0, "wide");
        const p = cellToPosition({ row: 0, col: 1 }, "wide");
        const updates = [{ draft_id: "moving", positionX: p.x, positionY: p.y }];
        expect(rowCountAfter(updates, [settled], "wide", 3)).toBe(3);
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

    it("resolveGridDrop lands in a growth column when cols allow it", () => {
        const a = draftInCell("a", 0, 2, "wide");
        const target = cellToPosition({ row: 0, col: 3 }, "wide");
        const updates = resolveGridDrop({
            groupDrafts: [a, draftAt("dragged", target.x + 10, target.y)],
            draggedDraftId: "dragged",
            draggedOrigin: null,
            dropX: target.x + 10,
            dropY: target.y,
            layout: "wide",
            cols: 4
        });
        expect(updates).toEqual([
            { draft_id: "dragged", positionX: target.x, positionY: target.y }
        ]);
    });
});
