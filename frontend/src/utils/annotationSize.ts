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
        { cols: spanFor(args.storedWidth, cardWidth(args.layout), GRID_CELL_GAP) },
        args.layout
    ),
    height: args.rowHeight
});
