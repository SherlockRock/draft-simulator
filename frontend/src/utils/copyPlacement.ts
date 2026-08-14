import type { CardLayout } from "./canvasCardLayout";
import type { CanvasGroup } from "./schemas";
import {
    cardWidth,
    getSeriesGroupDimensions,
    SERIES_CARD_GAP,
    SERIES_PADDING_X
} from "./helpers";
import {
    cellToPosition,
    configuredRowsAfterDrop,
    contentBoundsOf,
    firstEmptyRect,
    GRID_CELL_GAP,
    gridColsOf,
    gridRowsOf,
    materializeGrid,
    resolveContainerDims,
    rowsOfItems,
    resolveGridDims,
    type GridFootprint,
    type GridItem
} from "./gridLayout";
import { gridContentHeightForRows, memberY, rowSpanFor } from "./gridRows";
import {
    childCardsOf,
    childrenOf,
    gridItemsOf,
    maxChildSpanCols,
    nodeSize,
    spanFor,
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
    /**
     * Grid metadata the paste has to persist alongside the position — present
     * only when it CHANGES, so an ordinary copy into a container that already
     * has room stays a single request.
     *
     * Rows only. A copy has no drop point, so no growth COLUMN is owed and
     * `cols` below is deliberately not `effectiveGridCols` — but
     * `firstEmptyRect` genuinely does place a copy on a row past the configured
     * count, and the container is sized to include it. Leaving the count behind
     * makes that row last only as long as the copy sits in it.
     */
    groupMetadata?: { gridRows: number };
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

/** The kind-independent geometry needed to place a copy. */
export type CopySubject = {
    id: string;
    kind: GridItem["kind"];
    positionX: number;
    positionY: number;
    width: number;
    height: number;
    inset: number;
};

/**
 * Takes the whole tree rather than a pre-filtered `groupDrafts` because both
 * branches that need children need them shaped differently — the grid branch
 * wants footprint stamps, the series branch wants play order — and both are
 * `canvasTree`'s job (design §7). The two callers were each hand-writing
 * `drafts.filter((d) => d.group_id === group.id)`, which is the query that had
 * already drifted three ways.
 */
export const resolveCopyPlacement = (args: {
    subject: CopySubject;
    group: CanvasGroup | undefined;
    tree: CanvasTree;
    layout: CardLayout;
}): CopyPlacement => {
    const { subject, group, tree, layout } = args;
    const footprint: GridFootprint = {
        cols: spanFor(subject.width, cardWidth(layout), GRID_CELL_GAP),
        // One row outside a grid, where rows do not exist. The grid branch
        // below re-derives it against the destination's own row model.
        rows: 1
    };

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
        // The copy must claim the rows it will PAINT, or a note that spans two
        // lands in a one-row hole and overlaps whatever is under it.
        //
        // Measured from row 0 rather than from the landing row, which is not
        // known yet. The two agree except where a SIZING member sits inside the
        // span: every un-sized row otherwise measures `cardHeight(layout)`
        // whatever its index, so the span does not depend on where it starts.
        const gridFootprint: GridFootprint =
            subject.kind === "annotation"
                ? {
                      cols: footprint.cols,
                      rows: rowSpanFor(
                          subject.height,
                          0,
                          rowsOfItems(items, layout),
                          layout
                      )
                  }
                : footprint;
        const cell = firstEmptyRect(items, gridFootprint, cols);
        // A copy is a brand-new Card and is by definition NOT in `items`, so it
        // has to be projected in before materializing — `materializeGrid`
        // throws on an assignment with no item rather than guessing a Card's
        // geometry. Its `position` here is a placeholder; the row model
        // replaces it below.
        const copy: GridItem = {
            id: `${subject.id}-copy`,
            kind: subject.kind,
            footprint: gridFootprint,
            position: cellToPosition(cell, layout),
            cell,
            inset: subject.inset,
            height: subject.height
        };
        const projected = [...items, copy];
        const { rows } = materializeGrid({
            items: projected,
            assignments: [{ id: copy.id, kind: subject.kind, cell }],
            layout
        });
        // §6.0a rule 2: the container's height is the sum of its ROW BANDS, so
        // a copy landing beside a Bo3 adds no height at all — under the retired
        // row count it added a whole card's worth.
        // Rule 3: the copy's y is its ROW's, not the uniform lattice's. Landing
        // beside a Bo3 puts it at that row's baseline, level with the series'
        // first game, rather than at the row's top edge.
        const copyRow = rows.find((r) => r.ids.includes(copy.id));
        const position = {
            x: cellToPosition(cell, layout).x,
            y: copyRow ? memberY(copyRow, copy.inset) : cellToPosition(cell, layout).y
        };
        // The count being APPLIED, so the container is sized to the row the
        // copy just landed on rather than to the floor it is leaving behind.
        const configuredRows = configuredRowsAfterDrop(group, cell, gridFootprint);
        const dims = resolveGridDims(
            group,
            gridContentHeightForRows(rows, configuredRows, layout),
            cols,
            layout
        );
        return {
            positionX: position.x,
            positionY: position.y,
            group_id: group.id,
            ...(resizesGroup(group, dims) ? { groupDims: dims } : {}),
            ...(configuredRows !== gridRowsOf(group)
                ? { groupMetadata: { gridRows: configuredRows } }
                : {})
        };
    }

    if (group?.type === "custom") {
        const positionX = subject.positionX;
        const positionY = subject.positionY + subject.height + GRID_CELL_GAP;
        // The union of what is already in the container plus the copy, rather
        // than the copy alone against the container's current size — the same
        // content-bounds rule the drop path uses, so the two agree.
        const dims = resolveContainerDims(
            group,
            contentBoundsOf([
                ...childrenOf(tree, group.id)
                    .filter((node) => node.kind !== "group")
                    .map((node) => ({
                        x:
                            node.kind === "card"
                                ? node.card.positionX
                                : node.annotation.positionX,
                        y:
                            node.kind === "card"
                                ? node.card.positionY
                                : node.annotation.positionY,
                        ...nodeSize(tree, node, layout)
                    })),
                {
                    x: positionX,
                    y: positionY,
                    width: subject.width,
                    height: subject.height
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
        if (subject.kind !== "card") {
            return {
                positionX: subject.positionX,
                positionY: subject.positionY + subject.height + GRID_CELL_GAP,
                group_id: null
            };
        }
        // `childCardsOf` sorts a series into play order, which puts an
        // index-less game LAST — this file carried a fifth copy of the
        // `seriesIndex ?? 0` comparator that sorted it first, so a copy of a
        // game in such a series landed under the wrong slot.
        const sortedDrafts = childCardsOf(tree, group.id);
        const draftIndex = sortedDrafts.findIndex(
            (groupDraft) => groupDraft.draft_id === subject.id
        );
        const sourceIndex = Math.max(0, draftIndex);
        const seriesDims = getSeriesGroupDimensions(sortedDrafts.length, layout);
        return {
            positionX:
                group.positionX +
                SERIES_PADDING_X +
                sourceIndex * (cardWidth(layout) + SERIES_CARD_GAP),
            positionY: group.positionY + seriesDims.height + GRID_CELL_GAP,
            group_id: null
        };
    }

    return {
        positionX: subject.positionX,
        positionY: subject.positionY + subject.height + GRID_CELL_GAP,
        group_id: null
    };
};
