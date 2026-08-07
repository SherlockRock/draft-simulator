import type { CanvasGroup } from "./schemas";
import { cardWidth, cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

export const GRID_CELL_GAP = 24;
export const GRID_PADDING = 16;
// Single source of truth; CustomGroupContainer re-exports this as
// CUSTOM_GROUP_HEADER_HEIGHT.
export const GRID_HEADER_HEIGHT = 48;
export const DEFAULT_GRID_COLS = 3;

export type GridCell = { row: number; col: number };

/** Lattice units a node covers. See `spanFor` in `canvasTree.ts`. */
export type GridFootprint = { rows: number; cols: number };

/**
 * A Card is always exactly one unit: a cell IS a card, so
 * `spanFor(cardWidth, cardWidth, gap)` is 1 in every layout. Dragging a *Group*
 * into a grid (step 5a) must use `footprintOf` instead — this constant is only
 * correct for Cards.
 */
export const CARD_FOOTPRINT: GridFootprint = { rows: 1, cols: 1 };

/**
 * One child of a grid Group, as the layout engine sees it: a rectangular stamp
 * at a known cell. Built by `canvasTree.gridItemsOf`, which is the only thing
 * that knows how to derive a footprint from a node.
 *
 * `position` is CONTAINER-relative px for both kinds — a Card's stored position
 * as-is, a child Group's absolute position minus its parent's (ADR-0006). It is
 * what `cell` was derived from, and `arrangeGrid` tie-breaks on it.
 */
export type GridItem = {
    id: string;
    kind: "card" | "group";
    footprint: GridFootprint;
    position: { x: number; y: number };
    cell: GridCell;
};

/**
 * Where the engine decided an item goes, in CONTAINER-relative px — the same
 * frame `GridItem.position` is in. A Card's is what gets persisted verbatim; a
 * Group's has to be rebased to absolute world before it goes on the wire
 * (ADR-0006), which is why this is not a `PositionUpdate`.
 */
export type GridPlacement = {
    id: string;
    kind: GridItem["kind"];
    positionX: number;
    positionY: number;
};

export type PositionUpdate = {
    draft_id: string;
    positionX: number;
    positionY: number;
    group_id?: string | null;
};

/**
 * Card placements as the `positions[]` wire shape.
 *
 * **Group placements are dropped**, deliberately: they belong in the `groups[]`
 * array step 4 adds, rebased to absolute world first. Nothing can put a Group
 * inside a grid before step 5a, so today this is total.
 */
export const toPositionUpdates = (placements: GridPlacement[]): PositionUpdate[] =>
    placements
        .filter((p) => p.kind === "card")
        .map((p) => ({
            draft_id: p.id,
            positionX: p.positionX,
            positionY: p.positionY
        }));

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
    row: Math.max(0, Math.round((y - GRID_HEADER_HEIGHT - GRID_PADDING) / cellH(layout))),
    col: Math.min(cols - 1, Math.max(0, Math.round((x - GRID_PADDING) / cellW(layout))))
});

// Columns that fit in the group's current width (mirror of the
// height-based row computation in the hint overlay).
export const colsFromWidth = (width: number, layout: CardLayout): number =>
    Math.max(1, Math.floor((width - 2 * GRID_PADDING + GRID_CELL_GAP) / cellW(layout)));

/**
 * Columns available as drag/drop targets.
 *
 * Three terms, and **the `+1` growth column belongs to the CONFIGURED one
 * only** (design §6): dropping past the configured count bumps `gridCols`, so
 * the affordance is owed there. The other two are "must fit" floors — a group
 * resized to six columns' width exposes six, not seven, and a six-wide child
 * likewise needs six, not seven. `max(configured, …) + 1` is the form rev 3
 * briefly adopted and rev 4 withdrew; it returns 7 for the resized-wider case.
 *
 * `maxChildSpan` is `canvasTree.maxChildSpanCols(tree, group.id, layout)` —
 * passed in rather than computed here because that lives one layer up and this
 * module must stay free of the tree (see the header of `canvasTree.ts`).
 * It defaults to 0 for the all-Cards case, where it can never dominate.
 */
export const effectiveGridCols = (
    group: CanvasGroup,
    layout: CardLayout,
    maxChildSpan = 0
): number =>
    Math.max(
        gridColsOf(group) + 1,
        maxChildSpan,
        colsFromWidth(group.width ?? 0, layout)
    );

const cellKey = (cell: GridCell) => `${cell.row}:${cell.col}`;

const spanOf = (footprint: GridFootprint) => ({
    rows: Math.max(1, footprint.rows),
    cols: Math.max(1, footprint.cols)
});

/** Every cell a footprint stamped with its top-left at `cell` covers. */
export const rectCells = (cell: GridCell, footprint: GridFootprint): GridCell[] => {
    const { rows, cols } = spanOf(footprint);
    const out: GridCell[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            out.push({ row: cell.row + row, col: cell.col + col });
        }
    }
    return out;
};

/**
 * Occupancy is per COVERED cell, not per item — a `2×4` series blocks eight
 * cells, and a `1×1` dropped on any of them collides.
 *
 * `bottomRow` (-1 when empty) is what bounds every outward search: the row band
 * below it is free by construction, so a free rect always exists.
 */
type Occupancy = { cells: Set<string>; bottomRow: number };

const emptyOccupancy = (): Occupancy => ({ cells: new Set<string>(), bottomRow: -1 });

const occupy = (occupancy: Occupancy, cell: GridCell, footprint: GridFootprint) => {
    for (const covered of rectCells(cell, footprint)) {
        occupancy.cells.add(cellKey(covered));
    }
    occupancy.bottomRow = Math.max(
        occupancy.bottomRow,
        cell.row + spanOf(footprint).rows - 1
    );
};

const isFree = (
    occupancy: Occupancy,
    cell: GridCell,
    footprint: GridFootprint
): boolean => {
    if (cell.row < 0 || cell.col < 0) return false;
    return rectCells(cell, footprint).every((c) => !occupancy.cells.has(cellKey(c)));
};

const occupancyOf = (items: GridItem[]): Occupancy => {
    const occupancy = emptyOccupancy();
    for (const item of items) occupy(occupancy, item.cell, item.footprint);
    return occupancy;
};

/**
 * Right-most column a footprint may start in without overhanging the grid.
 *
 * Clamped to 0 for a child wider than the grid. `effectiveGridCols`' must-fit
 * term stops that arising for a live grid, but these functions are also called
 * with the *configured* count (`copyPlacement`), and an unclamped scan would
 * never find a legal column — an infinite loop, not a wrong answer.
 */
const lastStartCol = (cols: number, footprint: GridFootprint) =>
    Math.max(0, cols - spanOf(footprint).cols);

const clampToGrid = (
    cell: GridCell,
    cols: number,
    footprint: GridFootprint
): GridCell => ({
    row: Math.max(0, cell.row),
    col: Math.min(Math.max(0, cell.col), lastStartCol(cols, footprint))
});

const firstFreeRectFrom = (
    occupancy: Occupancy,
    start: GridCell,
    footprint: GridFootprint,
    cols: number
): GridCell => {
    const maxCol = lastStartCol(cols, footprint);
    for (let row = start.row; ; row++) {
        const from = row === start.row ? Math.min(start.col, maxCol) : 0;
        for (let col = from; col <= maxCol; col++) {
            const cell = { row, col };
            if (isFree(occupancy, cell, footprint)) return cell;
        }
    }
};

/**
 * First cell, in reading order, where the WHOLE footprint is free.
 * `firstEmptyCell` generalized: identical for `1×1`.
 */
export const firstEmptyRect = (
    items: GridItem[],
    footprint: GridFootprint,
    cols: number
): GridCell => firstFreeRectFrom(occupancyOf(items), { row: 0, col: 0 }, footprint, cols);

const nearestFreeRectIn = (
    occupancy: Occupancy,
    footprint: GridFootprint,
    from: GridCell,
    cols: number
): GridCell => {
    const maxCol = lastStartCol(cols, footprint);
    // The row band below every occupied cell is free by construction, so a
    // candidate always exists at or above this limit.
    const rowLimit = Math.max(occupancy.bottomRow + 1, from.row);
    let best: GridCell = { row: rowLimit, col: 0 };
    let bestScore = Infinity;
    for (let row = 0; row <= rowLimit; row++) {
        for (let col = 0; col <= maxCol; col++) {
            const cell = { row, col };
            if (!isFree(occupancy, cell, footprint)) continue;
            const dRow = row - from.row;
            const dCol = col - from.col;
            const score = dRow * dRow + dCol * dCol;
            // Strict `<` makes reading order the tie-break.
            if (score < bestScore) {
                bestScore = score;
                best = cell;
            }
        }
    }
    return best;
};

/**
 * Free rect closest to `from` by cell distance, ties broken in reading order.
 *
 * The one relocation rule in the design: a drop that collides and cannot swap
 * moves the DRAGGED node here (decision 7), and a footprint that grows over a
 * neighbour moves the OCCUPANT here (§6.1).
 */
export const nearestFreeRect = (
    items: GridItem[],
    footprint: GridFootprint,
    from: GridCell,
    cols: number
): GridCell => nearestFreeRectIn(occupancyOf(items), footprint, from, cols);

const placementAt = (
    item: { id: string; kind: GridItem["kind"] },
    cell: GridCell,
    layout: CardLayout
): GridPlacement => {
    const position = cellToPosition(cell, layout);
    return { id: item.id, kind: item.kind, positionX: position.x, positionY: position.y };
};

const isUnit = (footprint: GridFootprint): boolean =>
    spanOf(footprint).rows === 1 && spanOf(footprint).cols === 1;

/**
 * Where a drop lands, and what (if anything) it displaces.
 *
 * Target = the top-left cell under the drop. Footprint fits free → place it.
 * Collision → **swap only when both nodes are `1×1`**; anything else relocates
 * the DRAGGED node to the nearest free rect and leaves the occupants alone
 * (decision 7). A `1×1` dragged onto a `2×4` series must not evict the series.
 *
 * The dragged node's footprint comes in separately from `items` because a node
 * entering from outside the group is not in `items` at all, and one that is has
 * a stale `cell` (it has been dragged since).
 */
export const resolveGridDrop = (args: {
    items: GridItem[];
    dragged: { id: string; kind: GridItem["kind"]; footprint: GridFootprint };
    draggedOrigin: { x: number; y: number } | null;
    dropX: number;
    dropY: number;
    layout: CardLayout;
    cols: number;
}): GridPlacement[] => {
    const { items, dragged, draggedOrigin, layout, cols } = args;
    const others = items.filter((i) => i.id !== dragged.id);
    const target = clampToGrid(
        positionToCell(args.dropX, args.dropY, layout, cols),
        cols,
        dragged.footprint
    );

    const covered = new Set(rectCells(target, dragged.footprint).map(cellKey));
    const collisions = others.filter((i) =>
        rectCells(i.cell, i.footprint).some((c) => covered.has(cellKey(c)))
    );
    if (collisions.length === 0) return [placementAt(dragged, target, layout)];

    const occupant = collisions[0];
    if (
        collisions.length === 1 &&
        isUnit(dragged.footprint) &&
        isUnit(occupant.footprint)
    ) {
        const occupantCell = draggedOrigin
            ? positionToCell(draggedOrigin.x, draggedOrigin.y, layout, cols)
            : // Entered from outside the grid: the occupant yields to the first
              // empty cell, treating the dragged node as settled in the target.
              firstEmptyRect(
                  [
                      ...others.filter((i) => i.id !== occupant.id),
                      {
                          ...occupant,
                          id: dragged.id,
                          kind: dragged.kind,
                          footprint: dragged.footprint,
                          position: cellToPosition(target, layout),
                          cell: target
                      }
                  ],
                  occupant.footprint,
                  cols
              );
        return [
            placementAt(dragged, target, layout),
            placementAt(occupant, occupantCell, layout)
        ];
    }

    return [
        placementAt(
            dragged,
            nearestFreeRectIn(occupancyOf(others), dragged.footprint, target, cols),
            layout
        )
    ];
};

/** Reading order over current cells, ties broken by raw position. */
const readingOrder = (items: GridItem[]): GridItem[] =>
    [...items].sort(
        (a, b) =>
            a.cell.row - b.cell.row ||
            a.cell.col - b.cell.col ||
            a.position.y - b.position.y ||
            a.position.x - b.position.x
    );

/**
 * Manual "tidy": rectangle packing that keeps every item as close to where the
 * user left it as the lattice allows. Nearest-first — take the ideal cell when
 * the whole footprint is free there, else the next free rect in reading order.
 */
export const arrangeGrid = (
    items: GridItem[],
    layout: CardLayout,
    cols: number
): GridPlacement[] => {
    const occupancy = emptyOccupancy();
    return readingOrder(items).map((item) => {
        const ideal = clampToGrid(item.cell, cols, item.footprint);
        const cell = isFree(occupancy, ideal, item.footprint)
            ? ideal
            : firstFreeRectFrom(occupancy, ideal, item.footprint, cols);
        occupy(occupancy, cell, item.footprint);
        return placementAt(item, cell, layout);
    });
};

/**
 * §6.1 — a node whose footprint grew **keeps its top-left cell and grows
 * right/down**; whatever it now covers is displaced to the nearest free rect.
 * One rule, three triggers: a series going Bo3 → Bo5, a nested Group resized
 * wider, and a card-layout change resizing the unit cell.
 *
 * Rejected alternative: relocating the grown node. The thing the user just
 * edited would be the thing that moves away from them, and a live Group resize
 * would teleport mid-drag.
 *
 * `items` carry post-growth footprints (`gridItemsOf` derives them from current
 * size), so growth is implicit. Only displaced siblings get placements — the
 * grown node and every untouched sibling are absent from the result.
 */
export const reflowAfterGrowth = (args: {
    items: GridItem[];
    grownId: string;
    layout: CardLayout;
    cols: number;
}): GridPlacement[] => {
    const { items, grownId, layout, cols } = args;
    const grown = items.find((i) => i.id === grownId);
    if (!grown) return [];

    const occupancy = emptyOccupancy();
    occupy(occupancy, grown.cell, grown.footprint);

    // Pass 1: everything that still fits where it is stays there. A card-layout
    // change can also make two untouched siblings overlap each other, so this
    // tests against live occupancy rather than against the grown rect alone.
    const displaced: GridItem[] = [];
    for (const item of readingOrder(items)) {
        if (item.id === grownId) continue;
        const cell = clampToGrid(item.cell, cols, item.footprint);
        if (cell.col === item.cell.col && isFree(occupancy, cell, item.footprint)) {
            occupy(occupancy, cell, item.footprint);
        } else {
            displaced.push(item);
        }
    }

    // Pass 2: the rest, nearest-first from where each one was.
    return displaced.map((item) => {
        const cell = nearestFreeRectIn(occupancy, item.footprint, item.cell, cols);
        occupy(occupancy, cell, item.footprint);
        return placementAt(item, cell, layout);
    });
};

/**
 * Painted size of a footprint rectangle, in px — `n` cells with the gaps
 * INSIDE the span, the same arithmetic `spanFor` inverts.
 *
 * `cellToPosition` gives the rectangle's top-left; together they are what the
 * drop overlay draws, which is why this is `1×1` = one card and not
 * `gridDimensions` (that one adds the container's header and padding).
 */
export const footprintPixelSize = (footprint: GridFootprint, layout: CardLayout) => {
    const { rows, cols } = spanOf(footprint);
    return {
        width: cols * cardWidth(layout) + (cols - 1) * GRID_CELL_GAP,
        height: rows * cardHeight(layout) + (rows - 1) * GRID_CELL_GAP
    };
};

export const gridDimensions = (rowCount: number, cols: number, layout: CardLayout) => ({
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

/**
 * Smallest size a container may be resized to. Shared with the resize handles
 * (`CustomGroupContainer`) on purpose: if the sizing rule below could shrink a
 * container past the resize clamp, it would end up smaller than the user is
 * able to make it again.
 */
export const MIN_GROUP_WIDTH = 200;
export const MIN_GROUP_HEIGHT = 150;

/**
 * Fallback size for a Group with no stored width/height, and the sizing
 * baseline for one the user has never resized. Re-exported by `canvasTree.ts`,
 * where the hit-test and footprint code reads them; they must also agree with
 * `groupWidth()`/`groupHeight()` in `CustomGroupContainer.tsx` (design §12).
 */
export const DEFAULT_GROUP_WIDTH = 400;
export const DEFAULT_GROUP_HEIGHT = 200;

/**
 * The size the user last set by hand, or 0 where they never have.
 *
 * `width`/`height` cannot answer this: they are the *rendered* size, which
 * every auto-sizing path also writes, so "the user wanted 900px" and "we grew
 * to 900px for something that has since left" are indistinguishable there.
 * That conflation is the whole reason every sizing path had to be
 * `Math.max(current, content)` and could therefore only ratchet.
 */
export const manualFloorOf = (group: CanvasGroup): { width: number; height: number } => ({
    width: group.metadata.manualWidth ?? 0,
    height: group.metadata.manualHeight ?? 0
});

/**
 * The one container-sizing rule: **max(manual floor, content bounds)**, never
 * a term reading the container's own current size.
 *
 * Both directions follow from it. Content that grows past the floor widens the
 * container; content that leaves lets it fall back to the floor — and to the
 * content bounds when the user never resized it. A manual resize is never
 * undone, because the floor is only ever written by `handleResizeEnd`.
 *
 * Design §6 also fixes the precedence when they disagree: a child that does not
 * fit the manual width widens it anyway ("a child must fit"), which is exactly
 * `max`.
 */
export const resolveContainerDims = (
    group: CanvasGroup,
    content: { width: number; height: number }
) => {
    const floor = manualFloorOf(group);
    // Never resized: the container's birth size is the floor, so emptying one
    // returns it to the size it was created at rather than collapsing it to the
    // resize minimum. Once the user has set a floor, theirs wins all the way
    // down to MIN_GROUP_*.
    const baseWidth = floor.width || DEFAULT_GROUP_WIDTH;
    const baseHeight = floor.height || DEFAULT_GROUP_HEIGHT;
    return {
        width: Math.max(MIN_GROUP_WIDTH, baseWidth, content.width),
        height: Math.max(MIN_GROUP_HEIGHT, baseHeight, content.height)
    };
};

/** `resolveContainerDims` for a grid container, whose content bounds are its lattice. */
export const resolveGridDims = (
    group: CanvasGroup,
    rows: number,
    cols: number,
    layout: CardLayout
) => resolveContainerDims(group, gridDimensions(rows, cols, layout));

/**
 * Content bounds of a free-layout container: the union of its children's rects
 * plus padding, and how far its left edge may travel right before it would
 * cross the leftmost child.
 *
 * `rects` are CONTAINER-relative. Cards are all this sees in 5a-0; child Group
 * rects join them in 5a-1 (design §6.2 / plan A10), which is why it takes rects
 * rather than `CanvasDraft`s.
 */
export const contentBoundsOf = (
    rects: { x: number; y: number; width: number; height: number }[]
): {
    width: number;
    height: number;
    maxLeftEdgeDelta: number;
    expandLeft: number;
} => {
    if (rects.length === 0) {
        return { width: 0, height: 0, maxLeftEdgeDelta: Infinity, expandLeft: 0 };
    }
    let maxRight = 0;
    let maxBottom = 0;
    let minLeft = Infinity;
    for (const rect of rects) {
        minLeft = Math.min(minLeft, rect.x);
        maxRight = Math.max(maxRight, rect.x + rect.width + GRID_PADDING);
        maxBottom = Math.max(maxBottom, rect.y + rect.height + GRID_PADDING);
    }
    return {
        width: maxRight,
        height: maxBottom,
        // Mirror images of the same number, so exactly one is ever nonzero:
        // how far the left edge may move IN before it crosses the leftmost
        // child, and how far it must move OUT because a child is already past
        // it. The second is what a drop near the frame's left edge produces.
        maxLeftEdgeDelta: Math.max(0, minLeft - GRID_PADDING),
        expandLeft: Math.max(0, GRID_PADDING - minLeft)
    };
};

/**
 * Rows the grid spans once `placements` are applied to `items` — counting the
 * BOTTOM row of each footprint, so a `2×4` series in row 0 makes the grid two
 * rows tall.
 */
export const rowCountAfter = (
    placements: GridPlacement[],
    items: GridItem[],
    layout: CardLayout,
    cols: number
): number => {
    const footprints = new Map(items.map((i) => [i.id, i.footprint]));
    const moved = new Map(
        placements.map((p) => [
            p.id,
            positionToCell(p.positionX, p.positionY, layout, cols)
        ])
    );
    let maxRow = 0;
    const bottom = (cell: GridCell, footprint: GridFootprint) =>
        cell.row + spanOf(footprint).rows - 1;
    for (const item of items) {
        maxRow = Math.max(
            maxRow,
            bottom(moved.get(item.id) ?? item.cell, item.footprint)
        );
    }
    for (const placement of placements) {
        if (footprints.has(placement.id)) continue;
        const cell = moved.get(placement.id);
        if (cell) maxRow = Math.max(maxRow, cell.row);
    }
    return maxRow + 1;
};

export type GridSettingsInput = {
    gridCols: number;
    rowLabels: string[];
    colLabels: string[];
};

export type GridMetadata = {
    layout: "grid";
    gridCols: number;
    rowLabels: string[];
    colLabels: string[];
};

// Overwrite the first `count` slots with trimmed edited values, preserve any
// stored entries beyond `count` (e.g. columns grown by drag past what the
// dialog last saw), then drop trailing empties while keeping interior holes so
// a labeled row/col after an unlabeled one keeps its index. Preserved entries
// are trimmed too, so a stored whitespace-only tail doesn't block the trim.
export const mergeLabels = (
    existing: string[],
    edited: string[],
    count: number
): string[] => {
    const length = Math.max(existing.length, count);
    const out: string[] = [];
    for (let i = 0; i < length; i++) {
        out.push(i < count ? (edited[i] ?? "").trim() : (existing[i] ?? "").trim());
    }
    let end = out.length;
    while (end > 0 && out[end - 1] === "") end--;
    return out.slice(0, end);
};

export const buildGridMetadata = (
    existing: { rowLabels?: string[]; colLabels?: string[] },
    settings: GridSettingsInput
): GridMetadata => ({
    layout: "grid",
    gridCols: settings.gridCols,
    colLabels: mergeLabels(
        existing.colLabels ?? [],
        settings.colLabels,
        settings.gridCols
    ),
    rowLabels: mergeLabels(
        existing.rowLabels ?? [],
        settings.rowLabels,
        settings.rowLabels.length
    )
});

// The row count a reflow will actually produce for `cols`. Runs the same
// arrangeGrid → rowCountAfter the save uses, so the dialog's row-label inputs
// match the arranged grid (arrangeGrid preserves position-derived ideal rows
// and pushes collisions into later rows — ceil(count/cols) would under-count).
export const arrangedRowCount = (
    items: GridItem[],
    layout: CardLayout,
    cols: number
): number => rowCountAfter(arrangeGrid(items, layout, cols), items, layout, cols);

// Pure save decision: the metadata to persist (always including labels) and
// whether the group must be reflowed. Reflow when creating a grid from a free
// group, or when an existing grid's column count changed.
export const resolveGridSave = (
    existing: {
        layout?: "free" | "grid";
        gridCols?: number;
        rowLabels?: string[];
        colLabels?: string[];
    },
    settings: GridSettingsInput
): { metadata: GridMetadata; reflow: boolean } => {
    const wasGrid = existing.layout === "grid";
    const colsChanged = settings.gridCols !== (existing.gridCols ?? DEFAULT_GRID_COLS);
    return {
        metadata: buildGridMetadata(existing, settings),
        reflow: !wasGrid || colsChanged
    };
};
