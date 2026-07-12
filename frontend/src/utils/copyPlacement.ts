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
    cellToPosition,
    firstEmptyCell,
    GRID_CELL_GAP,
    gridColsOf,
    growGridDims,
    rowCountAfter
} from "./gridLayout";

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

export const resolveCopyPlacement = (args: {
    draft: CanvasDraft;
    group: CanvasGroup | undefined;
    groupDrafts: CanvasDraft[];
    layout: CardLayout;
}): CopyPlacement => {
    const { draft, group, groupDrafts, layout } = args;

    if (group?.type === "custom" && group.metadata.layout === "grid") {
        const cols = gridColsOf(group);
        const cell = firstEmptyCell(groupDrafts, layout, cols);
        const position = cellToPosition(cell, layout);
        const projected = [
            ...groupDrafts,
            { ...draft, positionX: position.x, positionY: position.y }
        ];
        const rows = rowCountAfter([], projected, layout, cols);
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
        const sortedDrafts = [...groupDrafts].sort(
            (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
        );
        const draftIndex = sortedDrafts.findIndex(
            (groupDraft) => groupDraft.Draft.id === draft.Draft.id
        );
        const sourceIndex = Math.max(0, draftIndex);
        const seriesDims = getSeriesGroupDimensions(groupDrafts.length, layout);
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
