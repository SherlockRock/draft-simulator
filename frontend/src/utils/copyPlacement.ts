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
    firstEmptyRect,
    GRID_CELL_GAP,
    gridColsOf,
    growGridDims,
    rowCountAfter,
    type GridItem
} from "./gridLayout";
import { childCardsOf, gridItemsOf, type CanvasTree } from "./canvasTree";

const GROUP_PADDING = 16;

export type CopyPlacement = {
    positionX: number;
    positionY: number;
    group_id: string | null;
    groupDims?: {
        width: number;
        height: number;
    };
};

const growsGroup = (
    group: CanvasGroup,
    dims: { width: number; height: number }
): boolean => dims.width > (group.width ?? 0) || dims.height > (group.height ?? 0);

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
        const cols = gridColsOf(group);
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
        const dims = growGridDims(group, rows, cols, layout);
        return {
            positionX: position.x,
            positionY: position.y,
            group_id: group.id,
            ...(growsGroup(group, dims) ? { groupDims: dims } : {})
        };
    }

    if (group?.type === "custom") {
        const positionX = draft.positionX;
        const positionY = draft.positionY + cardHeight(layout) + GRID_CELL_GAP;
        const currentWidth = group.width ?? 400;
        const currentHeight = group.height ?? 200;
        const width = Math.max(
            currentWidth,
            positionX + cardWidth(layout) + GROUP_PADDING
        );
        const height = Math.max(
            currentHeight,
            positionY + cardHeight(layout) + GROUP_PADDING
        );
        return {
            positionX,
            positionY,
            group_id: group.id,
            ...(width > currentWidth || height > currentHeight
                ? { groupDims: { width, height } }
                : {})
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
