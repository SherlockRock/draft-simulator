import type { CanvasDraft, CanvasGroup } from "./schemas";
import { cardWidth, cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

export const GRID_CELL_GAP = 24;
export const GRID_PADDING = 16;
// Single source of truth; CustomGroupContainer re-exports this as
// CUSTOM_GROUP_HEADER_HEIGHT.
export const GRID_HEADER_HEIGHT = 48;
export const DEFAULT_GRID_COLS = 3;

export type GridCell = { row: number; col: number };
export type PositionUpdate = {
    draft_id: string;
    positionX: number;
    positionY: number;
    group_id?: string | null;
};

export const isGridGroup = (group: CanvasGroup): boolean =>
    group.type === "custom" && group.metadata.layout === "grid";

export const gridColsOf = (group: CanvasGroup): number =>
    group.metadata.gridCols ?? DEFAULT_GRID_COLS;

const cellW = (layout: CardLayout) => cardWidth(layout) + GRID_CELL_GAP;
const cellH = (layout: CardLayout) => cardHeight(layout) + GRID_CELL_GAP;

export const cellToPosition = (cell: GridCell, layout: CardLayout) => ({
    x: GRID_PADDING + cell.col * cellW(layout),
    y: GRID_HEADER_HEIGHT + GRID_PADDING + cell.row * cellH(layout)
});

export const positionToCell = (
    x: number,
    y: number,
    layout: CardLayout,
    cols: number
): GridCell => ({
    row: Math.max(
        0,
        Math.round((y - GRID_HEADER_HEIGHT - GRID_PADDING) / cellH(layout))
    ),
    col: Math.min(
        cols - 1,
        Math.max(0, Math.round((x - GRID_PADDING) / cellW(layout)))
    )
});

const cellKey = (cell: GridCell) => `${cell.row}:${cell.col}`;

const occupiedKeys = (drafts: CanvasDraft[], layout: CardLayout, cols: number) =>
    new Set(
        drafts.map((d) =>
            cellKey(positionToCell(d.positionX, d.positionY, layout, cols))
        )
    );

export const firstEmptyCell = (
    drafts: CanvasDraft[],
    layout: CardLayout,
    cols: number
): GridCell => {
    const occupied = occupiedKeys(drafts, layout, cols);
    for (let row = 0; ; row++) {
        for (let col = 0; col < cols; col++) {
            if (!occupied.has(cellKey({ row, col }))) return { row, col };
        }
    }
};

export const resolveGridDrop = (args: {
    groupDrafts: CanvasDraft[];
    draggedDraftId: string;
    draggedOrigin: { x: number; y: number } | null;
    dropX: number;
    dropY: number;
    layout: CardLayout;
    cols: number;
}): PositionUpdate[] => {
    const { groupDrafts, draggedDraftId, draggedOrigin, layout, cols } = args;
    const targetCell = positionToCell(args.dropX, args.dropY, layout, cols);
    const targetPos = cellToPosition(targetCell, layout);
    const others = groupDrafts.filter((d) => d.Draft.id !== draggedDraftId);
    const occupant = others.find(
        (d) =>
            cellKey(positionToCell(d.positionX, d.positionY, layout, cols)) ===
            cellKey(targetCell)
    );

    const updates: PositionUpdate[] = [
        { draft_id: draggedDraftId, positionX: targetPos.x, positionY: targetPos.y }
    ];
    if (!occupant) return updates;

    let occupantCell: GridCell;
    if (draggedOrigin) {
        occupantCell = positionToCell(draggedOrigin.x, draggedOrigin.y, layout, cols);
    } else {
        // Card entered from outside the grid: occupant yields to the first
        // empty cell, treating the dragged card as settled in the target.
        const settled = others.filter((d) => d.Draft.id !== occupant.Draft.id);
        const virtual = [...settled];
        virtual.push({ ...occupant, positionX: targetPos.x, positionY: targetPos.y });
        occupantCell = firstEmptyCell(virtual, layout, cols);
    }
    const occupantPos = cellToPosition(occupantCell, layout);
    updates.push({
        draft_id: occupant.Draft.id,
        positionX: occupantPos.x,
        positionY: occupantPos.y
    });
    return updates;
};

export const arrangeGrid = (
    drafts: CanvasDraft[],
    layout: CardLayout,
    cols: number
): PositionUpdate[] => {
    // Nearest-first: sort by ideal cell in reading order (ties by actual
    // y, then x), assign the ideal cell if free, else the next empty cell
    // in reading order.
    const withIdeal = drafts.map((d) => ({
        draft: d,
        ideal: positionToCell(d.positionX, d.positionY, layout, cols)
    }));
    withIdeal.sort((a, b) => {
        const cellOrder = a.ideal.row - b.ideal.row || a.ideal.col - b.ideal.col;
        if (cellOrder !== 0) return cellOrder;
        return (
            a.draft.positionY - b.draft.positionY ||
            a.draft.positionX - b.draft.positionX
        );
    });

    const taken = new Set<string>();
    const nextEmptyFrom = (start: GridCell): GridCell => {
        let { row, col } = start;
        for (;;) {
            if (!taken.has(cellKey({ row, col }))) return { row, col };
            col++;
            if (col >= cols) {
                col = 0;
                row++;
            }
        }
    };

    return withIdeal.map(({ draft, ideal }) => {
        const cell = taken.has(cellKey(ideal)) ? nextEmptyFrom(ideal) : ideal;
        taken.add(cellKey(cell));
        const pos = cellToPosition(cell, layout);
        return { draft_id: draft.Draft.id, positionX: pos.x, positionY: pos.y };
    });
};

export const gridDimensions = (
    rowCount: number,
    cols: number,
    layout: CardLayout
) => ({
    width:
        2 * GRID_PADDING +
        cols * cardWidth(layout) +
        Math.max(0, cols - 1) * GRID_CELL_GAP,
    height:
        GRID_HEADER_HEIGHT +
        2 * GRID_PADDING +
        rowCount * cardHeight(layout) +
        Math.max(0, rowCount - 1) * GRID_CELL_GAP
});

export const rowCountAfter = (
    updates: PositionUpdate[],
    otherDrafts: CanvasDraft[],
    layout: CardLayout,
    cols: number
): number => {
    const updatedIds = new Set(updates.map((u) => u.draft_id));
    let maxRow = 0;
    for (const u of updates) {
        maxRow = Math.max(
            maxRow,
            positionToCell(u.positionX, u.positionY, layout, cols).row
        );
    }
    for (const d of otherDrafts) {
        if (updatedIds.has(d.Draft.id)) continue;
        maxRow = Math.max(
            maxRow,
            positionToCell(d.positionX, d.positionY, layout, cols).row
        );
    }
    return maxRow + 1;
};
