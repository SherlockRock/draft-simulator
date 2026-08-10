import {
    effectiveGridCols,
    isGridGroup,
    reflowAfterGrowth,
    type GridAssignment
} from "./gridLayout";
import {
    gridItemsOf,
    groupById,
    maxChildSpanCols,
    parentIdOf,
    type CanvasTree
} from "./canvasTree";
import type { CardLayout } from "./canvasCardLayout";

/**
 * Which siblings a series displaces when its game count grows.
 *
 * §6.1's rule, wired for the ONE trigger it is safe for: a manual series'
 * length change. The grown node keeps its top-left cell and grows right; the
 * occupants of the newly covered cells relocate to the nearest free rect. Only
 * the displaced siblings come back — the series itself produces no placement.
 *
 * A length change moves WIDTH only: getSeriesGroupDimensions' height is
 * independent of the game count, so no row can change height here, and §6.0a's
 * row cascade is never triggered.
 *
 * `null` means "no work" — no parent, a non-grid parent, or nothing displaced.
 * It is never an error.
 *
 * The derivation order is not negotiable and mirrors `gridColsFor` /
 * `gridItemsFor` in Canvas.tsx: footprints -> maxChildSpanCols -> effective
 * cols -> cells. Deriving the span from the items would be circular, since an
 * item's cell is clamped by the column count.
 */
export const seriesGrowthReflow = (args: {
    tree: CanvasTree;
    seriesId: string;
    layout: CardLayout;
}): { parentId: string; placements: GridAssignment[] } | null => {
    const { tree, seriesId, layout } = args;

    // `parentIdOf` returns undefined for a node that is not in the tree and
    // null for one sitting at the top level; neither has a grid to reflow.
    const parentId = parentIdOf(tree, seriesId);
    if (!parentId) return null;

    const parent = groupById(tree, parentId);
    if (!parent || !isGridGroup(parent)) return null;

    const cols = effectiveGridCols(
        parent,
        layout,
        maxChildSpanCols(tree, parent.id, layout)
    );
    const placements = reflowAfterGrowth({
        items: gridItemsOf(tree, parent.id, layout, cols),
        grownId: seriesId,
        cols
    });

    if (placements.length === 0) return null;
    return { parentId, placements };
};
