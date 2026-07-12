import { describe, expect, it } from "vitest";
import type { CardLayout } from "./canvasCardLayout";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import { resolveCopyPlacement } from "./copyPlacement";
import {
    cardHeight,
    cardWidth,
    getSeriesGroupDimensions,
    SERIES_CARD_GAP,
    SERIES_PADDING
} from "./helpers";
import { cellToPosition, GRID_CELL_GAP, gridDimensions } from "./gridLayout";

const layout: CardLayout = "compact";

function draftAt(
    id: string,
    positionX: number,
    positionY: number,
    groupId: string | null,
    seriesIndex?: number
): CanvasDraft {
    return {
        positionX,
        positionY,
        group_id: groupId,
        source_type: "canvas",
        Draft: {
            id,
            name: id,
            picks: Array(20).fill(""),
            type: "canvas",
            ...(seriesIndex !== undefined ? { seriesIndex } : {})
        }
    };
}

function groupWith(args: {
    id: string;
    type: "custom" | "series";
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
    layout?: "free" | "grid";
    gridCols?: number;
}): CanvasGroup {
    return {
        id: args.id,
        canvas_id: "canvas-1",
        name: args.id,
        type: args.type,
        positionX: args.positionX ?? 0,
        positionY: args.positionY ?? 0,
        width: args.width,
        height: args.height,
        metadata: {
            layout: args.layout,
            gridCols: args.gridCols
        }
    };
}

describe("resolveCopyPlacement", () => {
    it("places grid copies in the first empty cell and grows when a row fills", () => {
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 100,
            height: 100,
            layout: "grid",
            gridCols: 2
        });
        const first = cellToPosition({ row: 0, col: 0 }, layout);
        const second = cellToPosition({ row: 0, col: 1 }, layout);
        const drafts = [
            draftAt("a", first.x, first.y, group.id),
            draftAt("b", second.x, second.y, group.id)
        ];

        const placement = resolveCopyPlacement({
            draft: drafts[0],
            group,
            groupDrafts: drafts,
            layout
        });

        const target = cellToPosition({ row: 1, col: 0 }, layout);
        expect(placement.positionX).toBe(target.x);
        expect(placement.positionY).toBe(target.y);
        expect(placement.group_id).toBe(group.id);
        expect(placement.groupDims).toEqual(gridDimensions(2, 2, layout));
    });

    it("keeps free-layout copies in the same group directly below the source", () => {
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 1000,
            height: 1200,
            layout: "free"
        });
        const draft = draftAt("a", 120, 160, group.id);

        expect(
            resolveCopyPlacement({ draft, group, groupDrafts: [draft], layout })
        ).toEqual({
            positionX: 120,
            positionY: 160 + cardHeight(layout) + GRID_CELL_GAP,
            group_id: group.id
        });
    });

    it("grows a free-layout group just enough to contain an overflowing copy", () => {
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 450,
            height: 500,
            layout: "free"
        });
        const draft = draftAt("a", 40, 40, group.id);
        const placement = resolveCopyPlacement({
            draft,
            group,
            groupDrafts: [draft],
            layout
        });

        expect(placement.group_id).toBe(group.id);
        expect(placement.groupDims).toEqual({
            width: 450,
            height:
                40 +
                cardHeight(layout) +
                GRID_CELL_GAP +
                cardHeight(layout) +
                16
        });
    });

    it("places series copies below the rendered group aligned to the source slot", () => {
        const group = groupWith({
            id: "series-1",
            type: "series",
            positionX: 300,
            positionY: 400,
            height: 40
        });
        const firstDraft = draftAt("a", 0, 0, group.id, 0);
        const draft = draftAt("b", 0, 0, group.id, 1);
        const groupDrafts = [draft, firstDraft];
        const seriesDims = getSeriesGroupDimensions(groupDrafts.length, layout);

        expect(resolveCopyPlacement({ draft, group, groupDrafts, layout })).toEqual({
            positionX:
                300 + SERIES_PADDING + cardWidth(layout) + SERIES_CARD_GAP,
            positionY: 400 + seriesDims.height + GRID_CELL_GAP,
            group_id: null
        });
    });

    it("places ungrouped copies directly below the source", () => {
        const draft = draftAt("a", 800, 900, null);

        expect(
            resolveCopyPlacement({ draft, group: undefined, groupDrafts: [], layout })
        ).toEqual({
            positionX: 800,
            positionY: 900 + cardHeight(layout) + GRID_CELL_GAP,
            group_id: null
        });
    });
});
