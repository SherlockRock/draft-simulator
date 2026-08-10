import { describe, expect, it } from "vitest";
import { getDraftWorldPosition, sortedSeriesDrafts } from "./canvasWorldPosition";
import {
    GROUP_BORDER_WIDTH,
    SERIES_CARD_GAP,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_X,
    SERIES_PADDING_Y,
    cardWidth,
    getSeriesDraftWorldPosition
} from "./helpers";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";

const LAYOUT: CardLayout = "wide";

const card = (
    id: string,
    x: number,
    y: number,
    group_id: string | null,
    seriesIndex?: number
): CanvasDraft => ({
    draft_id: id,
    positionX: x,
    positionY: y,
    group_id,
    source_type: "canvas",
    Draft: {
        id,
        name: id,
        picks: Array(20).fill(""),
        type: "canvas",
        ...(seriesIndex !== undefined ? { seriesIndex } : {})
    }
});

const group = (type: "custom" | "series"): CanvasGroup => ({
    id: "g1",
    canvas_id: "c1",
    name: "G",
    type,
    positionX: 1000,
    positionY: 600,
    metadata: {}
});

describe("getDraftWorldPosition", () => {
    it("returns a loose Card's stored position unchanged", () => {
        expect(getDraftWorldPosition(card("d1", 40, 90, null), null, [], LAYOUT)).toEqual(
            {
                x: 40,
                y: 90
            }
        );
    });

    it("offsets a Card in a custom group by the group's world position", () => {
        const c = card("d1", 40, 90, "g1");
        expect(getDraftWorldPosition(c, group("custom"), [c], LAYOUT)).toEqual({
            x: 1040,
            y: 690
        });
    });

    // The bug this helper exists to kill: both nav call sites returned a bare
    // group.positionY for a series game, so panning to one from search or the
    // sidebar centred the viewport a header-plus-padding above the Card.
    it("includes the series header and padding in a game's y", () => {
        const g = group("series");
        const games = [
            card("d0", 0, 0, "g1", 0),
            card("d1", 0, 0, "g1", 1),
            card("d2", 0, 0, "g1", 2)
        ];

        const pos = getDraftWorldPosition(games[1], g, games, LAYOUT);

        expect(pos.y).toBe(
            g.positionY +
                GROUP_BORDER_WIDTH +
                SERIES_HEADER_HEIGHT +
                SERIES_PADDING_Y +
                SERIES_GAME_CONTROLS_HEIGHT
        );
        expect(pos.y).not.toBe(g.positionY);
        expect(pos.x).toBe(
            g.positionX + SERIES_PADDING_X + (cardWidth(LAYOUT) + SERIES_CARD_GAP)
        );
    });

    // One definition of a series game's world rect, not two.
    it("agrees with the helper the connection layer already uses", () => {
        const g = group("series");
        const games = [card("d0", 0, 0, "g1", 0), card("d1", 0, 0, "g1", 1)];

        expect(getDraftWorldPosition(games[1], g, games, LAYOUT)).toEqual(
            getSeriesDraftWorldPosition(g, 1, LAYOUT)
        );
    });

    it("ignores a series game's stored coordinates, which are not meaningful", () => {
        const g = group("series");
        const games = [card("d0", 7777, 8888, "g1", 0)];

        expect(getDraftWorldPosition(games[0], g, games, LAYOUT)).toEqual(
            getSeriesDraftWorldPosition(g, 0, LAYOUT)
        );
    });

    it("falls back to the first slot for a Card the group does not list", () => {
        const g = group("series");
        const stray = card("stray", 0, 0, "g1", 4);

        expect(getDraftWorldPosition(stray, g, [], LAYOUT)).toEqual(
            getSeriesDraftWorldPosition(g, 0, LAYOUT)
        );
    });
});

describe("sortedSeriesDrafts", () => {
    it("orders games by seriesIndex and sends unindexed Cards last", () => {
        const games = [
            card("b", 0, 0, "g1", 1),
            card("loose", 0, 0, "g1"),
            card("a", 0, 0, "g1", 0)
        ];

        expect(sortedSeriesDrafts(games).map((c) => c.Draft.id)).toEqual([
            "a",
            "b",
            "loose"
        ]);
    });
});
