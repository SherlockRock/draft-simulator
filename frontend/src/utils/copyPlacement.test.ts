import { describe, expect, it } from "vitest";
import type { CardLayout } from "./canvasCardLayout";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import { resolveCopyPlacement, type CopySubject } from "./copyPlacement";
import {
    cardHeight,
    cardWidth,
    getSeriesGroupDimensions,
    GROUP_BORDER_WIDTH,
    SERIES_CARD_GAP,
    SERIES_PADDING_X
} from "./helpers";
import {
    cellToPosition,
    GRID_CELL_GAP,
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    gridDimensions
} from "./gridLayout";

const layout: CardLayout = "compact";

function draftAt(
    id: string,
    positionX: number,
    positionY: number,
    groupId: string | null,
    seriesIndex?: number
): CanvasDraft {
    return {
        draft_id: id,
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
    gridRows?: number;
    manualWidth?: number;
    manualHeight?: number;
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
            gridCols: args.gridCols,
            gridRows: args.gridRows,
            manualWidth: args.manualWidth,
            manualHeight: args.manualHeight
        }
    };
}

function cardSubject(draft: CanvasDraft, cardLayout: CardLayout = layout): CopySubject {
    return {
        id: draft.draft_id,
        kind: "card",
        positionX: draft.positionX,
        positionY: draft.positionY,
        width: cardWidth(cardLayout),
        height: cardHeight(cardLayout),
        inset: GROUP_BORDER_WIDTH
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
            subject: cardSubject(drafts[0]),
            group,
            tree: { groups: [group], drafts, annotations: [] },
            layout
        });

        const target = cellToPosition({ row: 1, col: 0 }, layout);
        expect(placement.positionX).toBe(target.x);
        expect(placement.positionY).toBe(target.y);
        expect(placement.group_id).toBe(group.id);
        // §6.0a rule 2: the height is the sum of the row BANDS, so two
        // uniform Card rows is header + 2*padding + 2*ch + gap.
        expect(placement.groupDims).toEqual(
            gridDimensions(
                GRID_HEADER_HEIGHT +
                    2 * GRID_PADDING +
                    2 * cardHeight(layout) +
                    GRID_CELL_GAP,
                2,
                layout
            )
        );
    });

    /**
     * The paste half of the drop defect fixed the same day. `firstEmptyRect`
     * can legitimately place a copy on a row past the configured count — the
     * test above is exactly that case — and the container is sized to include
     * it. Without persisting the count, that row is a height the container
     * holds only while the copy occupies it: move the copy out and the
     * container collapses, taking the row with it.
     */
    it("persists the row count a copy pushed the grid onto", () => {
        const group = groupWith({
            id: "g1",
            type: "custom",
            layout: "grid",
            gridCols: 2,
            gridRows: 1
        });
        const first = cellToPosition({ row: 0, col: 0 }, layout);
        const second = cellToPosition({ row: 0, col: 1 }, layout);
        const drafts = [
            draftAt("a", first.x, first.y, group.id),
            draftAt("b", second.x, second.y, group.id)
        ];

        const placement = resolveCopyPlacement({
            subject: cardSubject(drafts[0]),
            group,
            tree: { groups: [group], drafts, annotations: [] },
            layout
        });

        expect(placement.positionY).toBe(cellToPosition({ row: 1, col: 0 }, layout).y);
        expect(placement.groupMetadata).toEqual({ gridRows: 2 });
    });

    it("sends no metadata when the copy fits the rows already configured", () => {
        // A one-request paste is the common case; a copy landing inside the
        // configured grid must not fire a metadata write that changes nothing.
        const group = groupWith({
            id: "g1",
            type: "custom",
            layout: "grid",
            gridCols: 2,
            gridRows: 4
        });
        const drafts = [draftAt("a", 0, 0, group.id)];

        const placement = resolveCopyPlacement({
            subject: cardSubject(drafts[0]),
            group,
            tree: { groups: [group], drafts, annotations: [] },
            layout
        });

        expect(placement.groupMetadata).toBeUndefined();
    });

    it("keeps free-layout copies in the same group directly below the source", () => {
        // The manual floor is what "the user made this group 1000x1200" looks
        // like since 5a-0 — without it the copy would resolve the group DOWN to
        // its content bounds, which is the point of the slice.
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 1000,
            height: 1200,
            layout: "free",
            manualWidth: 1000,
            manualHeight: 1200
        });
        const draft = draftAt("a", 120, 160, group.id);

        expect(
            resolveCopyPlacement({
                subject: cardSubject(draft),
                group,
                tree: { groups: [group], drafts: [draft], annotations: [] },
                layout
            })
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
            layout: "free",
            manualWidth: 450,
            manualHeight: 500
        });
        const draft = draftAt("a", 40, 40, group.id);
        const placement = resolveCopyPlacement({
            subject: cardSubject(draft),
            group,
            tree: { groups: [group], drafts: [draft], annotations: [] },
            layout
        });

        expect(placement.group_id).toBe(group.id);
        expect(placement.groupDims).toEqual({
            width: 450,
            height: 40 + cardHeight(layout) + GRID_CELL_GAP + cardHeight(layout) + 16
        });
    });

    // Plan A11: this call passed the CONFIGURED count, and `gridItemsOf` derives
    // each item's cell through `positionToCell`, which clamps `col` to
    // `cols - 1` — so a child WIDER than the configured grid registered two
    // columns left of where it is, and the copy was handed a cell it covers.
    it("counts a child wider than the configured grid at its real column", () => {
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 4000,
            height: 4000,
            layout: "grid",
            gridCols: 2,
            manualWidth: 4000,
            manualHeight: 4000
        });
        // Three columns wide, parked with its top-left at column 2 — so it
        // covers columns 2..4 and leaves column 1 free.
        const childOrigin = cellToPosition({ row: 0, col: 2 }, layout);
        const wideChild: CanvasGroup = {
            id: "wide",
            canvas_id: "canvas-1",
            name: "wide",
            type: "custom",
            positionX: childOrigin.x,
            positionY: childOrigin.y,
            width: 3 * cardWidth(layout) + 2 * GRID_CELL_GAP,
            height: cardHeight(layout),
            parent_group_id: "g1",
            metadata: {}
        };
        const occupant = cellToPosition({ row: 0, col: 0 }, layout);
        const draft = draftAt("a", occupant.x, occupant.y, "g1");

        const placement = resolveCopyPlacement({
            subject: cardSubject(draft),
            group,
            tree: {
                groups: [group, wideChild],
                drafts: [draft],
                annotations: []
            },
            layout
        });

        // Column 1. Clamped to the configured count the child registers at
        // column 1 and covers 1..3, which pushes the copy down to row 1.
        expect(placement.positionX).toBe(cellToPosition({ row: 0, col: 1 }, layout).x);
        expect(placement.positionY).toBe(cellToPosition({ row: 0, col: 1 }, layout).y);
    });

    it("shrinks a free-layout group the user never resized back to its contents", () => {
        // The 5a-0 ratchet removal, from the copy surface: `growsGroup` used to
        // suppress any dimension that was not larger, leaving a container stuck
        // at whatever an earlier auto-grow had made it.
        const group = groupWith({
            id: "g1",
            type: "custom",
            width: 4000,
            height: 4000,
            layout: "free"
        });
        const draft = draftAt("a", 40, 40, group.id);
        const placement = resolveCopyPlacement({
            subject: cardSubject(draft),
            group,
            tree: { groups: [group], drafts: [draft], annotations: [] },
            layout
        });

        expect(placement.groupDims).toEqual({
            width: 40 + cardWidth(layout) + 16,
            height: 40 + cardHeight(layout) + GRID_CELL_GAP + cardHeight(layout) + 16
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

        expect(
            resolveCopyPlacement({
                subject: cardSubject(draft),
                group,
                tree: { groups: [group], drafts: groupDrafts, annotations: [] },
                layout
            })
        ).toEqual({
            positionX: 300 + SERIES_PADDING_X + cardWidth(layout) + SERIES_CARD_GAP,
            positionY: 400 + seriesDims.height + GRID_CELL_GAP,
            group_id: null
        });
    });

    it("aligns a series copy by Canvas Card identity when Draft identity repeats", () => {
        const group = groupWith({
            id: "series-1",
            type: "series",
            positionX: 300,
            positionY: 400
        });
        const firstBase = draftAt("card-a", 0, 0, group.id, 0);
        const secondBase = draftAt("card-b", 0, 0, group.id, 1);
        const firstDraft: CanvasDraft = {
            ...firstBase,
            Draft: { ...firstBase.Draft, id: "shared-draft" }
        };
        const secondDraft: CanvasDraft = {
            ...secondBase,
            Draft: { ...secondBase.Draft, id: "shared-draft" }
        };

        const placement = resolveCopyPlacement({
            subject: cardSubject(secondDraft),
            group,
            tree: {
                groups: [group],
                drafts: [firstDraft, secondDraft],
                annotations: []
            },
            layout
        });

        expect(placement.positionX).toBe(
            group.positionX + SERIES_PADDING_X + cardWidth(layout) + SERIES_CARD_GAP
        );
    });

    it("places ungrouped copies directly below the source", () => {
        const draft = draftAt("a", 800, 900, null);

        expect(
            resolveCopyPlacement({
                subject: cardSubject(draft),
                group: undefined,
                tree: { groups: [], drafts: [draft], annotations: [] },
                layout
            })
        ).toEqual({
            positionX: 800,
            positionY: 900 + cardHeight(layout) + GRID_CELL_GAP,
            group_id: null
        });
    });
});

describe("resolveCopyPlacement over a generalised subject", () => {
    it("finds a 2-cell hole for a 2-column annotation", () => {
        const pool = groupWith({
            id: "g-pool",
            type: "custom",
            layout: "grid",
            gridCols: 3
        });
        const left = cellToPosition({ row: 0, col: 0 }, "compact");
        const right = cellToPosition({ row: 0, col: 2 }, "compact");
        const drafts = [
            draftAt("d1", left.x, left.y, "g-pool"),
            draftAt("d2", right.x, right.y, "g-pool")
        ];
        const placement = resolveCopyPlacement({
            subject: {
                id: "a-wide",
                kind: "annotation",
                positionX: 0,
                positionY: 0,
                width: 720,
                height: 200,
                inset: GROUP_BORDER_WIDTH
            },
            group: pool,
            tree: { groups: [pool], drafts, annotations: [] },
            layout: "compact"
        });

        expect(placement.positionX).toBe(cellToPosition({ row: 1, col: 0 }, "compact").x);
        expect(placement.positionY).toBe(cellToPosition({ row: 1, col: 0 }, "compact").y);
    });

    it("sizes the container from the subject's own height", () => {
        const pool = groupWith({
            id: "g-pool",
            type: "custom",
            layout: "grid",
            gridCols: 1,
            width: 0,
            height: 0
        });
        const placement = resolveCopyPlacement({
            subject: {
                id: "a1",
                kind: "annotation",
                positionX: 0,
                positionY: 0,
                width: 380,
                height: 120,
                inset: GROUP_BORDER_WIDTH
            },
            group: pool,
            tree: { groups: [pool], drafts: [], annotations: [] },
            layout: "wide"
        });

        expect(placement.groupDims?.height).toBeLessThan(500);
        expect(placement.groupDims?.height).toBe(200);
    });

    it("offsets a free-Group copy by the subject's own height", () => {
        const free = groupWith({ id: "g-free", type: "custom", layout: "free" });
        const placement = resolveCopyPlacement({
            subject: {
                id: "a1",
                kind: "annotation",
                positionX: 10,
                positionY: 20,
                width: 380,
                height: 120,
                inset: GROUP_BORDER_WIDTH
            },
            group: free,
            tree: { groups: [free], drafts: [], annotations: [] },
            layout: "wide"
        });

        expect(placement.positionY).toBe(20 + 120 + GRID_CELL_GAP);
    });
});
