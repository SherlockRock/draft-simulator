import type { CanvasAnnotation } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";
import { cardWidth } from "./helpers";
import { footprintPixelWidth, GRID_CELL_GAP } from "./gridLayout";
import { spanFor } from "./canvasTree";

export const MIN_ANNOTATION_WIDTH = 56;
export const MIN_ANNOTATION_HEIGHT = 40;

/** A new annotation is one grid cell wide in the active card layout. */
export const defaultAnnotationSize = (
    layout: CardLayout
): { width: number; height: number } => ({
    width: cardWidth(layout),
    height: 120
});

/**
 * The hand-set floor for auto-sizing. Stored rendered dimensions are excluded:
 * auto-fit writes height, so using height here would make growth ratchet.
 */
export const annotationFloor = (
    annotation: Pick<CanvasAnnotation, "manualWidth" | "manualHeight">
): { width: number; height: number } => ({
    width: annotation.manualWidth ?? 0,
    height: annotation.manualHeight ?? 0
});

/** Resolves measured content height against the resize minimum and manual floor. */
export const autoFitHeight = (args: { measured: number; floor: number }): number => {
    const floor = Math.max(MIN_ANNOTATION_HEIGHT, args.floor);
    if (!Number.isFinite(args.measured)) return floor;
    return Math.max(floor, args.measured);
};

/**
 * The size an annotation PAINTS at inside a grid Group (design D5a).
 *
 * ⚠️ RENDER only. The stored `width`/`height` are never written by this — which
 * is what makes drag-into-grid then drag-back-out a lossless round trip rather
 * than a silent resize.
 *
 * Width snaps to whole cells, and specifically because width drives the column
 * span via `spanFor`, span feeds `maxChildSpanCols`, and that can change the
 * Group's effective column count. Un-snapped, a one-pixel resize drag would
 * silently reflow the whole grid horizontally.
 *
 * Height is the ROW's, not the note's. Non-circular in one pass: the STORED
 * height is an input to the row-height max (`gridRows.rowsOf` via
 * `canvasTree.nodeSize`), and the RENDERED height is its output — there is no
 * fixpoint to iterate.
 *
 * Rows keep auto-sizing to their tallest member uniformly; annotations are not
 * excluded from the max. A special case for one member kind was proposed and
 * withdrawn, and the concern it addressed is handled by arithmetic instead: a
 * Card is 384–960px tall, so in any mixed row the Cards dominate.
 */
export const snappedAnnotationSize = (args: {
    storedWidth: number;
    /** The band this note landed in — `gridRows.RowMetrics.height`. */
    rowHeight: number;
    layout: CardLayout;
}): { width: number; height: number } => ({
    width: footprintPixelWidth(
        {
            cols: spanFor(args.storedWidth, cardWidth(args.layout), GRID_CELL_GAP),
            rows: 1
        },
        args.layout
    ),
    height: args.rowHeight
});

/**
 * The nearest whole-column width to a hand-dragged one — the resize handle's
 * half of "the only valid sizes for a note inside a grid are full columns".
 *
 * ⚠️ NEAREST, not `spanFor`'s `ceil`, and the difference is the whole point.
 * `spanFor` answers "how many columns does this width NEED", where rounding up
 * is the only safe answer — a 730px note genuinely overflows one 700px cell.
 * This answers "which column count did the user MEAN", and ceil there is
 * unusable: the handle is seeded from the painted box, which already sits
 * exactly on a boundary, so `ceil` would turn one pixel of rightward jitter
 * into a whole extra column. On a corner handle every vertical drag carries
 * that jitter.
 *
 * Feeding this result back through `spanFor` is a fixpoint: an exact n-column
 * width needs exactly n columns.
 *
 * The one-column floor is deliberately NOT re-imposed here — `footprintPixelWidth`
 * runs the count through `spanOf`, whose own `Math.max(1, cols)` is the floor.
 * A local guard duplicating it was written, found to be unkillable by any
 * mutation (it changed no output), and removed rather than kept as code no test
 * can justify. The floor is reachable and load-bearing: every drag inside the
 * first cell's midpoint rounds to zero columns.
 *
 * Grid callers only. A loose note has no cells to snap to and keeps the width
 * the gesture gave it.
 */
export const snapWidthToCells = (draggedWidth: number, layout: CardLayout): number => {
    const cell = cardWidth(layout);
    const pitch = cell + GRID_CELL_GAP;
    if (!Number.isFinite(draggedWidth) || pitch <= 0) return cell;
    return footprintPixelWidth(
        { cols: Math.round((draggedWidth + GRID_CELL_GAP) / pitch), rows: 1 },
        layout
    );
};

export type AnnotationRenderSize = { width: number; height: number };

/**
 * Selects a grid annotation's render size from settled membership.
 *
 * The local drag snapshot wins even though the active note is absent from
 * `settledRows`. A remotely dragged note has no local snapshot and therefore
 * returns null once excluded from those rows, matching a relayed Card's use of
 * its intrinsic render geometry while it is in flight.
 */
export const annotationRenderSize = (args: {
    annotation: { id: string; width: number };
    activeAnnotationId: string | null;
    frozenSize: AnnotationRenderSize | null;
    settledRows: ReadonlyArray<{ ids: ReadonlyArray<string>; height: number }>;
    layout: CardLayout;
}): AnnotationRenderSize | null => {
    if (args.activeAnnotationId === args.annotation.id && args.frozenSize !== null) {
        return args.frozenSize;
    }
    const row = args.settledRows.find((entry) => entry.ids.includes(args.annotation.id));
    if (!row) return null;
    return snappedAnnotationSize({
        storedWidth: args.annotation.width,
        rowHeight: row.height,
        layout: args.layout
    });
};
