import type { CanvasGroup } from "./schemas";
import { cardWidth, cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";
import {
    memberY,
    rowAtY,
    rowsFromHeight,
    rowsOf,
    rowsOfIndexed,
    type RowMember,
    type RowMetrics
} from "./gridRows";

/**
 * The frame border both container components paint. Declared in `helpers.ts`
 * and re-exported here so grid code can take it from the module it belongs to,
 * matching how `DEFAULT_GROUP_WIDTH` is declared here and re-exported by
 * `canvasTree.ts`. Declaring it there is what keeps `helpers` ⇄ `gridLayout`
 * acyclic.
 */
export { GROUP_BORDER_WIDTH } from "./helpers";

export const GRID_CELL_GAP = 24;
export const GRID_PADDING = 16;
// Single source of truth; CustomGroupContainer re-exports this as
// CUSTOM_GROUP_HEADER_HEIGHT.
export const GRID_HEADER_HEIGHT = 48;
export const DEFAULT_GRID_COLS = 3;

export type GridCell = { row: number; col: number };

/**
 * Lattice cells a node covers, on both axes. `cols` via `canvasTree.spanFor`,
 * `rows` via `gridRows.rowSpanFor`.
 *
 * ⚠️ THE ROW AXIS WAS REMOVED ONCE AND IS BACK DELIBERATELY. §6.0a rule 1 took
 * it out on the argument that "a row's height is a property of its MEMBERSHIP,
 * so any `rows × cardHeight` answer could only ever hand the drop highlight a
 * rectangle of the wrong size". That argument was right about the FORMULA and
 * is not overturned: nothing multiplies rows by a height. `footprintPixelHeight`
 * asks the row model for each covered row's real height instead, and spanning
 * members are excluded from sizing those rows so the two cannot feed back into
 * each other. Maintainer ruling 2026-08-14; see
 * `docs/designs/canvas-annotation-row-spanning-design.md`.
 *
 * `rows` is REQUIRED rather than defaulted, exactly as §6.0a required its
 * absence: every construction site should have to state that it is 1, which is
 * what makes "this change is a no-op for Cards" a written claim instead of an
 * assumption.
 *
 * Only annotations ever exceed 1 row. A series is one row tall however much
 * chrome it carries — the row grows for it, which is still rule 1's behaviour
 * for everything that cannot span.
 */
export type GridFootprint = { cols: number; rows: number };

/**
 * A Card is always exactly one unit: a cell IS a card, so
 * `spanFor(cardWidth, cardWidth, gap)` is 1 in every layout, and a Card cannot
 * span rows. Dragging a *Group* into a grid (step 5a) must use `footprintOf`
 * instead — this constant is only correct for Cards.
 */
export const CARD_FOOTPRINT: GridFootprint = { cols: 1, rows: 1 };

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
    kind: "card" | "group" | "annotation";
    footprint: GridFootprint;
    position: { x: number; y: number };
    cell: GridCell;
    /** Top edge to first draft Card — `canvasTree.insetOf`. Feeds rule 3. */
    inset: number;
    /** Painted height, from `canvasTree.nodeSize`. Feeds rule 2. */
    height: number;
};

/**
 * Where the engine decided an item goes, as a LATTICE CELL.
 *
 * This is the engine's currency now. It used to hand back pixels, which forced
 * every caller to know how a cell becomes a coordinate — and a row's `y` is no
 * longer a function of its index alone, so there was no honest answer to give.
 * `materializeGrid` is the one place a cell becomes a pixel.
 */
export type GridAssignment = {
    id: string;
    kind: GridItem["kind"];
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
 * **Group AND annotation placements are dropped**, deliberately: each has its
 * own array on the wire, and `gridPersistence.splitGridPlacements` is the only
 * thing that should be routing placements to arrays at all. This helper survives
 * for the Card-only callers that predate it.
 *
 * ⚠️ Before `splitGridPlacements` existed, this filter simply LOST every Group
 * placement — total while nothing could put a Group in a grid, and silently
 * lossy the moment one could. An annotation is the third kind to walk into it.
 * If you are reaching for this function from a path that can see a non-Card,
 * you want `splitGridPlacements`.
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

/**
 * The minimum number of rows a grid container presents.
 *
 * Absent means one — every grid that predates the setting keeps its old height,
 * which was derived from content alone. It is a FLOOR: content needing more
 * rows still gets them (see `gridContentHeightForRows`).
 */
export const DEFAULT_GRID_ROWS = 1;

export const gridRowsOf = (group: CanvasGroup): number =>
    group.metadata.gridRows ?? DEFAULT_GRID_ROWS;

const cellW = (layout: CardLayout) => cardWidth(layout) + GRID_CELL_GAP;
const cellH = (layout: CardLayout) => cardHeight(layout) + GRID_CELL_GAP;

export const cellToPosition = (cell: GridCell, layout: CardLayout) => ({
    x: GRID_PADDING + cell.col * cellW(layout),
    y: GRID_HEADER_HEIGHT + GRID_PADDING + cell.row * cellH(layout)
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
    cols: Math.max(1, footprint.cols),
    rows: Math.max(1, footprint.rows)
});

/**
 * The column count to PERSIST after a drop — the configured floor raised, when
 * needed, to cover the last column the landing actually occupies.
 *
 * `landing.col + 1` was right only for a one-column Card. A 3-column series
 * landing at column 1 occupies through column 3 and needs FOUR, and persisting
 * three sized the container 404px — exactly one column — narrower than its own
 * child (browser-reproduced, `vertical`, container 1220 vs a right edge of
 * 1608). Column 1 became reachable in 5a-6, which made a Bo-N series exactly N
 * columns: before that a Bo3 measured 4, so `lastStartCol` was `4 - 4 = 0` and
 * column 0 was the only legal start.
 *
 * Still the CONFIGURED count and never the layout one: the layout count carries
 * the +1 growth column, and persisting that would widen the grid by a column on
 * every drop. `nearestFreeRectIn` and `clampToGrid` both bound the landing by
 * `lastStartCol`, so this can never exceed the layout count it resolved
 * against.
 */
export const configuredColsAfterDrop = (
    group: CanvasGroup,
    landing: GridCell,
    footprint: GridFootprint
): number => Math.max(gridColsOf(group), landing.col + spanOf(footprint).cols);

/**
 * The row count to PERSIST after a drop — the same rule, on the other axis.
 *
 * Columns have grown on drop since §6; rows never did, and the asymmetry was
 * visible: a Card dropped into the growth row of a one-row grid was accepted
 * and the container grew to hold it, but `gridRows` stayed 1 — so moving that
 * Card away collapsed the container back to one row and the row the user had
 * added did not survive. Under `gridContentHeightForRows` the stored count is
 * the container's height FLOOR, so a drop that does not raise it buys a row
 * only for as long as something occupies it.
 *
 * NOW CARRIES A FOOTPRINT TERM, symmetric with the column rule. It deliberately
 * did not, on §6.0a rule 1's "a landing occupies exactly one row and `row + 1`
 * is total for a Card and a Bo5 alike" — still true of a Card and a Bo5, and no
 * longer true of a note that spans. Without the term a two-row note dropped in
 * the last row persists a count one short of what it occupies, and the row it
 * sits in survives only while it does.
 */
export const configuredRowsAfterDrop = (
    group: CanvasGroup,
    landing: GridCell,
    footprint: GridFootprint
): number => Math.max(gridRowsOf(group), landing.row + spanOf(footprint).rows);

/**
 * Every cell a footprint stamped at `cell` covers — `rows` tall, `cols` wide.
 *
 * Was `rowCells`, which stamped a single row under §6.0a rule 1. Identical for
 * any `rows: 1` footprint, which is every Card, series and nested Group.
 */
export const rectCells = (cell: GridCell, footprint: GridFootprint): GridCell[] => {
    const { cols, rows } = spanOf(footprint);
    const out: GridCell[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            out.push({ row: cell.row + row, col: cell.col + col });
        }
    }
    return out;
};

/**
 * Occupancy is per COVERED cell, not per item — a Bo3 blocks three cells, and a
 * one-column node dropped on any of them collides.
 *
 * `maxRow` (-1 when empty) is what bounds every outward search: the row band
 * below it is free by construction, so a free rect always exists. Rule 5 kept
 * this when multi-row stamping was deleted, and it survives multi-row stamping
 * coming back — but only because `occupy` now records a footprint's LAST row.
 * The guarantee is "no occupied cell at any row > maxRow", which a first-row
 * reading would break for a spanning item.
 */
type Occupancy = { cells: Set<string>; maxRow: number };

const emptyOccupancy = (): Occupancy => ({ cells: new Set<string>(), maxRow: -1 });

const occupy = (occupancy: Occupancy, cell: GridCell, footprint: GridFootprint) => {
    for (const covered of rectCells(cell, footprint)) {
        occupancy.cells.add(cellKey(covered));
    }
    // The footprint's LAST row, not its first. `maxRow` is what guarantees the
    // band below it is free, and a two-row item whose top is the lowest start
    // would otherwise leave its own bottom row inside the "free" band.
    occupancy.maxRow = Math.max(occupancy.maxRow, cell.row + spanOf(footprint).rows - 1);
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
    const rowLimit = Math.max(occupancy.maxRow + 1, from.row);
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

const assignmentAt = (
    item: { id: string; kind: GridItem["kind"] },
    cell: GridCell
): GridAssignment => ({ id: item.id, kind: item.kind, cell });

/**
 * ⚠️ THE SWITCH FOR ROW SPANNING, and it is deliberately still OFF.
 *
 * Flipping this to `false` is the one edit that stops an annotation's height
 * sizing its row and lets it span instead. Everything downstream of that —
 * `gridRows.heightOf`'s exclusion, its `SPANNED_ROW_HEIGHT` fallback,
 * `rowSpanFor`, `footprintPixelHeight`, `snapHeightToRows` — is built and
 * tested, but nothing yet CONSUMES a span, so turning it on now would only
 * make a tall note render at 120px and overflow its row.
 *
 * Typed `boolean` rather than left to inference so the `||` below stays a real
 * runtime branch instead of narrowing to a constant.
 */
export const ANNOTATIONS_SIZE_ROWS: boolean = true;

/**
 * Whether an item's own geometry shapes the row it starts in — `gridRows`'
 * `sizesRow`, decided here because this is the layer that knows about kinds.
 *
 * Cards, series and nested Groups always size their row: none of them can span,
 * so none of them can be circular.
 */
export const sizesRow = (kind: GridItem["kind"]): boolean =>
    kind !== "annotation" || ANNOTATIONS_SIZE_ROWS;

/** `items` as the row model sees them. */
export const rowMembersOf = (items: GridItem[]): RowMember[] =>
    items.map((i) => ({
        id: i.id,
        y: i.position.y,
        inset: i.inset,
        height: i.height,
        sizesRow: sizesRow(i.kind)
    }));

/** The rows `items` currently form. */
export const rowsOfItems = (items: GridItem[], layout: CardLayout): RowMetrics[] =>
    rowsOf(rowMembersOf(items), layout);

/** Column of a container-relative x. The x axis is unchanged by §6.0a. */
export const colAt = (x: number, layout: CardLayout, cols: number): number =>
    Math.min(cols - 1, Math.max(0, Math.round((x - GRID_PADDING) / cellW(layout))));

/**
 * The cell a container-relative point targets, against `rows`.
 *
 * Replaces `positionToCell`. The row half can no longer be a division: rows
 * have different heights, so the inverse needs the actual bands. `rows` must be
 * the TARGETING membership — `others`, excluding the dragged node — or a
 * hovering Bo3 raises the target row's baseline, shifting the row's offset,
 * changing which row the point falls in, frame after frame.
 */
export const cellAt = (
    rows: RowMetrics[],
    x: number,
    y: number,
    layout: CardLayout,
    cols: number
): GridCell => ({
    row: rowAtY(rows, y, layout),
    col: colAt(x, layout, cols)
});

/**
 * Turn cell assignments into container-relative pixels — the ONE place a cell
 * becomes a coordinate.
 *
 * Takes the whole projected item set rather than just the moved nodes, because
 * a row's geometry is a property of its MEMBERS: a series joining a row raises
 * its baseline and every Card already in it drops by the difference, and a row
 * growing taller pushes every row below it down. Returning only the moved node
 * would leave the rest of the container drawn to the previous layout.
 *
 * Returns a placement only where the position actually changed, so a drop that
 * moves one Card in an all-Card grid still writes exactly one row — and so
 * `rematerializeGrid` can be called freely on a settled container.
 *
 * The rows come back alongside because they are the EXACT projection of the
 * post-drop layout. A caller that instead re-derived them by running `rowsOf`
 * over the materialized pixels would be running the inferential path over the
 * exact one's output — the same answer when everything is right, and a second
 * place to be wrong when it is not.
 */
export const materializeGrid = (args: {
    items: GridItem[];
    assignments: GridAssignment[];
    layout: CardLayout;
}): { placements: GridPlacement[]; rows: RowMetrics[] } => {
    const { items, assignments, layout } = args;
    const assigned = new Map(assignments.map((a) => [a.id, a]));
    const byId = new Map(items.map((i) => [i.id, i]));

    // Every assigned node must be in `items`. A node entering from outside is
    // the caller's job to project in FIRST, with its real inset and height — an
    // earlier draft defaulted it to a Card, which silently mis-aligned an
    // incoming nested container and drew its highlight one card tall.
    for (const a of assignments) {
        if (!byId.has(a.id)) {
            throw new Error(
                `materializeGrid: assignment for "${a.id}" has no item; ` +
                    `project entering nodes into \`items\` before calling`
            );
        }
    }

    const projected = items.map((item) => ({
        item,
        cell: assigned.get(item.id)?.cell ?? item.cell
    }));

    // Keyed by the ASSIGNED lattice row, so sparse indices stay sparse: a drop
    // targeting row 3 of a one-row grid lands in row 3, with rows 1-2 empty.
    const rows = rowsOfIndexed(
        projected.map(({ item, cell }) => ({
            id: item.id,
            index: cell.row,
            inset: item.inset,
            height: item.height,
            sizesRow: sizesRow(item.kind)
        })),
        layout
    );
    const rowOf = new Map<string, RowMetrics>();
    for (const row of rows) for (const id of row.ids) rowOf.set(id, row);

    const placements: GridPlacement[] = [];
    for (const { item, cell } of projected) {
        const row = rowOf.get(item.id);
        if (!row) continue;
        // The ROW cascade is intended: a member moves because its row's
        // baseline or a row above it changed. The COLUMN is not — an unassigned
        // member keeps its stored x. Recomputing it from `item.cell.col` would
        // push every member through `colAt`'s round-and-clamp under whichever
        // `cols` the call site used, and those differ (`gridItemsFor` carries
        // the +1 growth column, `resyncGroupSize` and `copyPlacement` do not),
        // so an unrelated resync would drag members left.
        const positionX = assigned.has(item.id)
            ? GRID_PADDING + cell.col * cellW(layout)
            : item.position.x;
        const positionY = memberY(row, item.inset);
        // BOTH axes, or a pure COLUMN move is silently dropped.
        if (
            Math.round(item.position.x) === Math.round(positionX) &&
            Math.round(item.position.y) === Math.round(positionY)
        ) {
            continue;
        }
        placements.push({ id: item.id, kind: item.kind, positionX, positionY });
    }
    return { placements, rows };
};

/**
 * The swap's geometric precondition: the two nodes cover CONGRUENT rectangles,
 * so exchanging their top-left cells cannot overlap anything.
 *
 * Was `isUnit(a) && isUnit(b)` — both exactly one cell wide, on the single-row
 * lattice where that meant both exactly one cell. With a row axis that test
 * would let a 1×2 note swap with a 1×1 Card and leave the note's second row
 * sitting on top of whatever was below.
 *
 * ⚠️ THIS IS A LIVE BEHAVIOUR CHANGE, not just a spanning one. Two notes with
 * the same non-unit footprint — a pool of 2-column notes, reachable today —
 * could not be reordered before and can now. That is D6a's own rationale
 * applied consistently: "every drag would fling the note to the nearest free
 * cell instead of swapping" was the complaint, and it was as true of two wide
 * notes as of two narrow ones. Unequal footprints still relocate the dragged
 * node and leave occupants alone.
 */
const sameFootprint = (a: GridFootprint, b: GridFootprint): boolean => {
    const left = spanOf(a);
    const right = spanOf(b);
    return left.cols === right.cols && left.rows === right.rows;
};

/**
 * Kinds that may be EVICTED by a swap (design D6a).
 *
 * The gate is leaf-ness, not card-ness. Its original comment explains it exists
 * so CONTAINERS are never evicted — and an annotation is a leaf, not a
 * container, so that rationale never decided its case. Left as card-only, the
 * champion-pool Group (every cell an annotation) could never be reordered:
 * every drag would fling the note to the nearest free cell instead of swapping.
 */
const isLeafKind = (kind: GridItem["kind"]): boolean =>
    kind === "card" || kind === "annotation";

/**
 * Where a drop lands, and what (if anything) it displaces.
 *
 * Target = the top-left cell under the drop. Footprint fits free → place it.
 * Collision → **swap only when both nodes are LEAVES with CONGRUENT
 * footprints** — a Card or an annotation (D6a); anything else relocates the
 * DRAGGED node to the nearest free rect and leaves the occupants alone
 * (decision 7). A `1×1` dragged onto a `2×4` series must not evict the series,
 * and a 2-row note dragged onto a 1-row Card must not either.
 *
 * ⚠️ The `kind` half of that test is not redundant with the footprint half
 * (decision 7, amended round 2). `sameFootprint` tests GEOMETRY, and a default
 * 400×200 nested Group is `1×1` in four of the six card layouts and `2×1` in
 * the other two — so without the `kind` gate the swap was reachable for
 * containers *and* its availability depended on `cardLayout`, which is
 * canvas-level and broadcast. One user flipping a display toggle would have
 * changed what everyone's drop gesture did to containers. A Card dropped onto a
 * nested Group relocates the **Card**; the Group is never evicted.
 *
 * The dragged node's footprint comes in separately from `items` because a node
 * entering from outside the group is not in `items` at all, and one that is has
 * a stale `cell` (it has been dragged since).
 */
export const resolveGridDrop = (args: {
    items: GridItem[];
    /**
     * TARGETING rows — `rowsOfItems(others)`, EXCLUDING the dragged node.
     * Including it lets a hovering Bo3 raise the target row's baseline, which
     * shifts the row's offset, which changes which row the point falls in,
     * frame after frame.
     */
    rows: RowMetrics[];
    dragged: { id: string; kind: GridItem["kind"]; footprint: GridFootprint };
    draggedOrigin: { x: number; y: number } | null;
    dropX: number;
    dropY: number;
    layout: CardLayout;
    cols: number;
}): GridAssignment[] => {
    const { items, rows, dragged, draggedOrigin, layout, cols } = args;
    const others = items.filter((i) => i.id !== dragged.id);
    const target = clampToGrid(
        cellAt(rows, args.dropX, args.dropY, layout, cols),
        cols,
        dragged.footprint
    );

    const covered = new Set(rectCells(target, dragged.footprint).map(cellKey));
    const collisions = others.filter((i) =>
        rectCells(i.cell, i.footprint).some((c) => covered.has(cellKey(c)))
    );
    if (collisions.length === 0) return [assignmentAt(dragged, target)];

    const occupant = collisions[0];
    if (
        collisions.length === 1 &&
        isLeafKind(dragged.kind) &&
        isLeafKind(occupant.kind) &&
        sameFootprint(dragged.footprint, occupant.footprint)
    ) {
        const occupantCell = draggedOrigin
            ? cellAt(rows, draggedOrigin.x, draggedOrigin.y, layout, cols)
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
        return [assignmentAt(dragged, target), assignmentAt(occupant, occupantCell)];
    }

    return [
        assignmentAt(
            dragged,
            nearestFreeRectIn(occupancyOf(others), dragged.footprint, target, cols)
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
export const arrangeGrid = (items: GridItem[], cols: number): GridAssignment[] => {
    const occupancy = emptyOccupancy();
    return readingOrder(items).map((item) => {
        const ideal = clampToGrid(item.cell, cols, item.footprint);
        const cell = isFree(occupancy, ideal, item.footprint)
            ? ideal
            : firstFreeRectFrom(occupancy, ideal, item.footprint, cols);
        occupy(occupancy, cell, item.footprint);
        return assignmentAt(item, cell);
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
    cols: number;
}): GridAssignment[] => {
    const { items, grownId, cols } = args;
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
        return assignmentAt(item, cell);
    });
};

/**
 * Painted WIDTH of a footprint, in px — `n` cells with the gaps INSIDE the
 * span, the same arithmetic `spanFor` inverts.
 *
 * There is deliberately no height half any more: a row's height comes from
 * `gridRows.rowsOf` and depends on who ELSE is in the row, so a function
 * returning `rows * cardHeight` could only ever hand the drop highlight a
 * rectangle of the wrong size.
 */
export const footprintPixelWidth = (
    footprint: GridFootprint,
    layout: CardLayout
): number => {
    const { cols } = spanOf(footprint);
    return cols * cardWidth(layout) + (cols - 1) * GRID_CELL_GAP;
};

/**
 * Container size from a CONTENT HEIGHT rather than a row count — §6.0a rule 2.
 *
 * `rowCount * cellH` was only ever right while every row was one card tall.
 * `contentHeight` comes from `gridRows.gridContentHeight`, which ALREADY
 * includes the header and both paddings — do not add them again here. That is
 * the one arithmetic trap in this signature.
 */
export const gridDimensions = (
    contentHeight: number,
    cols: number,
    layout: CardLayout
) => ({
    width:
        2 * GRID_PADDING +
        cols * cardWidth(layout) +
        Math.max(0, cols - 1) * GRID_CELL_GAP,
    height: contentHeight
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
    contentHeight: number,
    cols: number,
    layout: CardLayout
) => resolveContainerDims(group, gridDimensions(contentHeight, cols, layout));

/**
 * Content bounds of a free-layout container: the union of its children's rects
 * plus padding, and how far its left edge may travel right before it would
 * cross the leftmost child.
 *
 * `rects` are CONTAINER-relative. Cards are all this sees in 5a-0; child Group
 * rects join them in 5a-1 and annotations later (design §6.2 / plan A10), which
 * is why it takes rects rather than canvas row types.
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

export type AnnotationContentRect = {
    group_id?: string | null;
    positionX: number;
    positionY: number;
    width: number;
    height: number;
};

/**
 * Container-relative annotation rects, grouped for free-layout content bounds.
 * Loose annotations have no container and therefore contribute to no bounds.
 */
export const annotationContentRectsOf = (
    annotations: readonly AnnotationContentRect[]
): Map<string, { x: number; y: number; width: number; height: number }[]> => {
    const rects = new Map<
        string,
        { x: number; y: number; width: number; height: number }[]
    >();
    for (const annotation of annotations) {
        if (!annotation.group_id) continue;
        const rect = {
            x: annotation.positionX,
            y: annotation.positionY,
            width: annotation.width,
            height: annotation.height
        };
        const list = rects.get(annotation.group_id);
        if (list) list.push(rect);
        else rects.set(annotation.group_id, [rect]);
    }
    return rects;
};

export type GridSettingsInput = {
    gridCols: number;
    gridRows: number;
    rowLabels: string[];
    colLabels: string[];
};

export type GridMetadata = {
    layout: "grid";
    gridCols: number;
    gridRows: number;
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
    gridRows: settings.gridRows,
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

/**
 * The row count a reflow will actually produce for `cols` — what the grid
 * settings dialog offers row-label inputs for.
 *
 * Runs the same `arrangeGrid` the save uses, so the inputs match the arranged
 * grid: `arrangeGrid` preserves position-derived ideal rows and pushes
 * collisions into later rows, and `ceil(count / cols)` would under-count.
 *
 * **`maxRow + 1`, not the number of distinct occupied rows.** With any row gap
 * those differ, and the distinct count offers fewer inputs than there are rows,
 * after which `mergeLabels`' `count` argument silently trims the stored labels
 * beyond it.
 */
export const arrangedRowCount = (items: GridItem[], cols: number): number => {
    const assignments = arrangeGrid(items, cols);
    if (assignments.length === 0) return 1;
    return Math.max(0, ...assignments.map((a) => a.cell.row)) + 1;
};

/**
 * Whether a resolved `GridMetadata` is what the group already stores.
 *
 * Lets an ordinary settings save — a rename, a classification change — stay ONE
 * request on a group whose grid nobody touched, instead of firing a second
 * layout write that races the first. Reads the same defaults `gridColsOf` and
 * `gridRowsOf` do, so a group that never stored a column count is not reported
 * as changing merely by having one written down.
 */
export const gridMetadataEquals = (
    existing: {
        layout?: "free" | "grid";
        gridCols?: number;
        gridRows?: number;
        rowLabels?: string[];
        colLabels?: string[];
    },
    next: GridMetadata
): boolean => {
    const sameLabels = (a: string[] | undefined, b: string[]) =>
        (a ?? []).length === b.length && (a ?? []).every((v, i) => v === b[i]);
    return (
        existing.layout === next.layout &&
        (existing.gridCols ?? DEFAULT_GRID_COLS) === next.gridCols &&
        (existing.gridRows ?? DEFAULT_GRID_ROWS) === next.gridRows &&
        sameLabels(existing.rowLabels, next.rowLabels) &&
        sameLabels(existing.colLabels, next.colLabels)
    );
};

/**
 * The grid configuration a manual resize implies — decision "resize sets the
 * counts" (2026-08-11).
 *
 * Before this, `handleResizeEnd` wrote only the `manualWidth`/`manualHeight`
 * floor and left `gridCols`/`gridRows` alone, so the size the user dragged and
 * the size the counts imply were free to disagree. Every sizing path derives
 * width as `max(floor, cols * cardWidth + gaps)` without ever reading the
 * container's CURRENT width, so any later re-derivation reconciled that
 * disagreement — a row-count edit was simply the one that surfaced it, by
 * moving the frame's width.
 *
 * The two were already contradicting each other in the other direction:
 * `effectiveGridCols` includes `colsFromWidth`, so a resize widened the
 * reachable drop columns while the next re-derivation discarded them.
 *
 * The counts this returns always describe a grid no LARGER than the size
 * dragged to (both terms floor), which is what guarantees the manual floor
 * still wins in `resolveContainerDims` and the container cannot snap after the
 * mouse comes up.
 */
export const resolveResizeGridSettings = (input: {
    width: number;
    height: number;
    rows: RowMetrics[];
    layout: CardLayout;
}): { gridCols: number; gridRows: number } => ({
    gridCols: colsFromWidth(input.width, input.layout),
    gridRows: rowsFromHeight(input.rows, input.height, input.layout)
});

// Pure save decision: the metadata to persist (always including labels) and
// whether the group must be reflowed. Reflow when creating a grid from a free
// group, or when an existing grid's column count changed.
export const resolveGridSave = (
    existing: {
        layout?: "free" | "grid";
        gridCols?: number;
        gridRows?: number;
        rowLabels?: string[];
        colLabels?: string[];
    },
    settings: GridSettingsInput
): { metadata: GridMetadata; reflow: boolean } => {
    const wasGrid = existing.layout === "grid";
    const colsChanged = settings.gridCols !== (existing.gridCols ?? DEFAULT_GRID_COLS);
    // A row-count change is deliberately NOT a reflow. Rows are a height floor,
    // not an arrangement input — `arrangeGrid` never reads them — so reflowing
    // on one would relocate every member for a change that only resizes the
    // frame. The caller re-derives the dimensions on BOTH branches and compares,
    // which covers a row change without a flag saying so.
    return {
        metadata: buildGridMetadata(existing, settings),
        reflow: !wasGrid || colsChanged
    };
};
