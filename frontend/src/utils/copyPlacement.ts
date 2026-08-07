import type { CardLayout } from "./canvasCardLayout";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import {
    cardHeight,
    cardWidth,
    getSeriesGroupDimensions,
    SERIES_CARD_GAP,
    SERIES_PADDING
} from "./helpers";
import {
    CARD_FOOTPRINT,
    cellToPosition,
    contentBoundsOf,
    firstEmptyRect,
    GRID_CELL_GAP,
    gridColsOf,
    resolveContainerDims,
    resolveGridDims,
    rowCountAfter,
    type GridItem
} from "./gridLayout";
import {
    childCardsOf,
    gridItemsOf,
    maxChildSpanCols,
    type CanvasTree
} from "./canvasTree";

export type CopyPlacement = {
    positionX: number;
    positionY: number;
    group_id: string | null;
    groupDims?: {
        width: number;
        height: number;
    };
};

/**
 * Persist the derived dimensions whenever they DIFFER, not only when they grow.
 * Since 5a-0 a container's size is `max(manual floor, content)` rather than
 * `max(current, content)`, so a copy can legitimately resolve it smaller — a
 * grow-only test would leave the stale, ratcheted size on the row.
 */
const resizesGroup = (
    group: CanvasGroup,
    dims: { width: number; height: number }
): boolean => dims.width !== (group.width ?? 0) || dims.height !== (group.height ?? 0);

/**
 * Takes the whole tree rather than a pre-filtered `groupDrafts` because both
 * branches that need children need them shaped differently — the grid branch
 * wants footprint stamps, the series branch wants play order — and both are
 * `canvasTree`'s job (design §7). The two callers were each hand-writing
 * `drafts.filter((d) => d.group_id === group.id)`, which is the query that had
 * already drifted three ways.
 */
export const resolveCopyPlacement = (args: {
    draft: CanvasDraft;
    group: CanvasGroup | undefined;
    tree: CanvasTree;
    layout: CardLayout;
}): CopyPlacement => {
    const { draft, group, tree, layout } = args;

    if (group?.type === "custom" && group.metadata.layout === "grid") {
        // The MUST-FIT term was missing here, and only that (plan A11). A copy
        // has no drop point, so no growth column is owed — but `gridItemsOf`
        // derives each item's cell through `positionToCell`, which clamps `col`
        // to `cols - 1`, so a 6-column child in a 3-column configured grid
        // registered at col 2. Occupancy was then wrong and `firstEmptyRect`
        // handed the copy a cell the child actually covered.
        //
        // Deliberately NOT `effectiveGridCols`: that carries the +1 growth
        // column, and a copy placed there would sit outside the container,
        // since the container's size comes from this same count and
        // `copyPlacement` never bumps `metadata.gridCols`.
        const cols = Math.max(
            gridColsOf(group),
            maxChildSpanCols(tree, group.id, layout)
        );
        const items = gridItemsOf(tree, group.id, layout, cols);
        const cell = firstEmptyRect(items, CARD_FOOTPRINT, cols);
        const position = cellToPosition(cell, layout);
        const copy: GridItem = {
            id: `${draft.draft_id}-copy`,
            kind: "card",
            footprint: CARD_FOOTPRINT,
            position: { x: position.x, y: position.y },
            cell
        };
        const rows = rowCountAfter([], [...items, copy], layout, cols);
        const dims = resolveGridDims(group, rows, cols, layout);
        return {
            positionX: position.x,
            positionY: position.y,
            group_id: group.id,
            ...(resizesGroup(group, dims) ? { groupDims: dims } : {})
        };
    }

    if (group?.type === "custom") {
        const positionX = draft.positionX;
        const positionY = draft.positionY + cardHeight(layout) + GRID_CELL_GAP;
        // The union of what is already in the container plus the copy, rather
        // than the copy alone against the container's current size — the same
        // content-bounds rule the drop path uses, so the two agree.
        const dims = resolveContainerDims(
            group,
            contentBoundsOf([
                ...childCardsOf(tree, group.id).map((child) => ({
                    x: child.positionX,
                    y: child.positionY,
                    width: cardWidth(layout),
                    height: cardHeight(layout)
                })),
                {
                    x: positionX,
                    y: positionY,
                    width: cardWidth(layout),
                    height: cardHeight(layout)
                }
            ])
        );
        return {
            positionX,
            positionY,
            group_id: group.id,
            ...(resizesGroup(group, dims) ? { groupDims: dims } : {})
        };
    }

    if (group?.type === "series") {
        // `childCardsOf` sorts a series into play order, which puts an
        // index-less game LAST — this file carried a fifth copy of the
        // `seriesIndex ?? 0` comparator that sorted it first, so a copy of a
        // game in such a series landed under the wrong slot.
        const sortedDrafts = childCardsOf(tree, group.id);
        const draftIndex = sortedDrafts.findIndex(
            (groupDraft) => groupDraft.Draft.id === draft.Draft.id
        );
        const sourceIndex = Math.max(0, draftIndex);
        const seriesDims = getSeriesGroupDimensions(sortedDrafts.length, layout);
        return {
            positionX:
                group.positionX +
                SERIES_PADDING +
                sourceIndex * (cardWidth(layout) + SERIES_CARD_GAP),
            positionY: group.positionY + seriesDims.height + GRID_CELL_GAP,
            group_id: null
        };
    }

    return {
        positionX: draft.positionX,
        positionY: draft.positionY + cardHeight(layout) + GRID_CELL_GAP,
        group_id: null
    };
};
