import { describe, expect, it } from "vitest";
import {
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
    getAnnotationAnchorWorldPosition,
    getSeriesDraftWorldPosition,
    getSeriesGroupDimensions
} from "./helpers";
import { GROUP_BORDER_WIDTH } from "./gridLayout";
import type { CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";

const ALL_LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

const seriesGroupAt = (pos: { x: number; y: number }): CanvasGroup => ({
    id: "s1",
    canvas_id: "canvas-1",
    name: "s1",
    type: "series",
    positionX: pos.x,
    positionY: pos.y,
    width: undefined,
    height: undefined,
    parent_group_id: null,
    metadata: {}
});

describe("a series' arithmetic matches its painted box", () => {
    const layout: CardLayout = "vertical";

    it("includes the per-game control block in its height", () => {
        expect(getSeriesGroupDimensions(3, layout).height).toBe(
            2 * GROUP_BORDER_WIDTH +
                SERIES_HEADER_HEIGHT +
                2 * SERIES_PADDING_Y +
                SERIES_GAME_CONTROLS_HEIGHT +
                cardHeight(layout)
        );
    });

    it("is independent of the game count", () => {
        expect(getSeriesGroupDimensions(5, layout).height).toBe(
            getSeriesGroupDimensions(1, layout).height
        );
    });

    it("puts a game's Card below the controls, not directly under the padding", () => {
        const group = seriesGroupAt({ x: 100, y: 200 });
        expect(getSeriesDraftWorldPosition(group, 0, layout).y).toBe(
            200 +
                GROUP_BORDER_WIDTH +
                SERIES_HEADER_HEIGHT +
                SERIES_PADDING_Y +
                SERIES_GAME_CONTROLS_HEIGHT
        );
    });

    /**
     * The browser measurement itself, pinned as literals ON PURPOSE — this is
     * the one test in the file that must not be able to agree with the code by
     * recomputing it. Measured 2026-08-09 at zoom 1, on the fixture canvas'
     * three-game series, in all six card layouts. `SERIES_GAME_CONTROLS_HEIGHT`
     * is a constant rather than a fit precisely because all six agreed.
     */
    it("equals the painted frame height measured in a browser, per layout", () => {
        const PAINTED: Record<CardLayout, number> = {
            vertical: 794.5,
            horizontal: 578.5,
            wide: 1054.5,
            "wide-draft-order": 1154.5,
            compact: 626.5,
            "draft-order": 922.5
        };
        for (const layout of ALL_LAYOUTS) {
            expect(getSeriesGroupDimensions(3, layout).height).toBe(PAINTED[layout]);
        }
    });
});

describe("getAnnotationAnchorWorldPosition", () => {
    const note = { positionX: 100, positionY: 200, width: 380, height: 120 };

    // Four anchors like a Card (D10). Unlike a Card, the rect comes from the
    // note's STORED size rather than from cardWidth/cardHeight — connection
    // geometry stays pure, it just reads a different width.
    it("puts each anchor on the stored rect", () => {
        expect(getAnnotationAnchorWorldPosition(note, "top")).toEqual({ x: 290, y: 200 });
        expect(getAnnotationAnchorWorldPosition(note, "bottom")).toEqual({
            x: 290,
            y: 320
        });
        expect(getAnnotationAnchorWorldPosition(note, "left")).toEqual({
            x: 100,
            y: 260
        });
        expect(getAnnotationAnchorWorldPosition(note, "right")).toEqual({
            x: 480,
            y: 260
        });
    });

    // Container-relative when grouped, exactly like a Card.
    it("offsets by the container when grouped", () => {
        expect(
            getAnnotationAnchorWorldPosition(note, "top", {
                positionX: 1000,
                positionY: 500
            })
        ).toEqual({ x: 1290, y: 700 });
    });

    // ⚠️ Pinned because it looks wrong and is not. A grouped note PAINTS at
    // `positionY - CUSTOM_GROUP_HEADER_HEIGHT` (annotationRenderTop), and a
    // grouped Card does the same (CanvasCard.tsx:653) — that offset cancels the
    // container's content box, which already starts one header below its own
    // origin. Adding a header term here would double-count it and float every
    // grouped note's line one header above the note.
    it("adds no header term, matching the Card path", () => {
        const grouped = getAnnotationAnchorWorldPosition(note, "top", {
            positionX: 0,
            positionY: 1000
        });
        expect(grouped.y).toBe(note.positionY + 1000);
    });

    // A resized note moves its own anchors: the rect is the STORED size, and
    // nothing about connections is allowed to read the grid-snapped render size.
    it("tracks the stored size rather than any snapped render size", () => {
        const wide = { ...note, width: 800 };
        expect(getAnnotationAnchorWorldPosition(wide, "right").x).toBe(900);
        expect(getAnnotationAnchorWorldPosition(wide, "top").x).toBe(500);
    });
});
