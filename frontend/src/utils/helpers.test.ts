import { describe, expect, it } from "vitest";
import {
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
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
