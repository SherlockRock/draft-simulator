import { describe, expect, it } from "vitest";
import { seriesGrowthReflow } from "./seriesGrowthReflow";
import { cellToPosition } from "./gridLayout";
import { memberY, rowsOfIndexed } from "./gridRows";
import {
    GROUP_BORDER_WIDTH,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
    getSeriesGroupDimensions
} from "./helpers";
import type { CanvasTree } from "./canvasTree";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";

const LAYOUT: CardLayout = "wide";

// Same fixture shapes as canvasTree.test.ts / groupDropResolver.test.ts.
const card = (
    id: string,
    opts: {
        group_id?: string | null;
        x?: number;
        y?: number;
        seriesIndex?: number | null;
    } = {}
): CanvasDraft => ({
    draft_id: id,
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    group_id: opts.group_id ?? null,
    source_type: "canvas",
    Draft: {
        id,
        name: id,
        picks: Array(20).fill(""),
        type: "canvas",
        ...(opts.seriesIndex === undefined ? {} : { seriesIndex: opts.seriesIndex })
    }
});

const group = (
    id: string,
    opts: {
        parent?: string | null;
        type?: "custom" | "series";
        x?: number;
        y?: number;
        layout?: "grid" | "free";
        cols?: number;
    } = {}
): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: opts.type ?? "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    parent_group_id: opts.parent ?? null,
    metadata: {
        ...(opts.layout ? { layout: opts.layout } : {}),
        ...(opts.cols === undefined ? {} : { gridCols: opts.cols })
    }
});

/**
 * A grid container `p` at the world origin, holding a Bo-N series `s` and any
 * loose Cards. A child Group stores ABSOLUTE world coordinates (ADR-0006), so a
 * cell is turned into a world position by adding the parent's own origin —
 * which is 0 here, keeping the fixtures readable.
 */
const treeWith = (args: {
    parentLayout?: "grid" | "free";
    cols?: number;
    games: number;
    seriesCol?: number;
    seriesRow?: number;
    cards?: { id: string; row: number; col: number }[];
    orphanSeries?: boolean;
}): CanvasTree => {
    const {
        parentLayout = "grid",
        cols = 6,
        games,
        seriesCol = 0,
        seriesRow = 0,
        cards = [],
        orphanSeries = false
    } = args;

    // §6.0a rule 3: row-mates have DIFFERENT stored y — each sits at the row's
    // baseline minus its own inset. Materializing the fixture through the same
    // row model the engine uses is not a nicety: `cellToPosition` for both
    // would put the series and a Card in the SAME row at two different row
    // KEYS, splitting them into two rows, and the collision this file is about
    // would silently stop happening.
    const CARD_INSET = GROUP_BORDER_WIDTH;
    const SERIES_INSET =
        GROUP_BORDER_WIDTH +
        SERIES_HEADER_HEIGHT +
        SERIES_PADDING_Y +
        SERIES_GAME_CONTROLS_HEIGHT;
    const rows = rowsOfIndexed(
        [
            {
                id: "s",
                index: seriesRow,
                inset: SERIES_INSET,
                height: getSeriesGroupDimensions(games, LAYOUT).height
            },
            ...cards.map((c) => ({
                id: c.id,
                index: c.row,
                inset: CARD_INSET,
                height: cardHeight(LAYOUT)
            }))
        ],
        LAYOUT
    );
    const yOf = (id: string, inset: number): number => {
        const row = rows.find((r) => r.ids.includes(id));
        return row ? memberY(row, inset) : 0;
    };

    const groups: CanvasGroup[] = [
        ...(orphanSeries ? [] : [group("p", { layout: parentLayout, cols })]),
        group("s", {
            type: "series",
            parent: orphanSeries ? null : "p",
            x: cellToPosition({ row: seriesRow, col: seriesCol }, LAYOUT).x,
            y: yOf("s", SERIES_INSET)
        })
    ];

    const drafts: CanvasDraft[] = [
        // The series' games — this is what footprintOf counts to get its span.
        ...Array.from({ length: games }, (_, i) =>
            card(`g${i}`, { group_id: "s", seriesIndex: i })
        ),
        ...cards.map((c) =>
            card(c.id, {
                group_id: "p",
                x: cellToPosition({ row: c.row, col: c.col }, LAYOUT).x,
                y: yOf(c.id, CARD_INSET)
            })
        )
    ];

    return { groups, drafts };
};

describe("seriesGrowthReflow", () => {
    it("returns null when the series has no parent", () => {
        const tree = treeWith({ games: 5, orphanSeries: true });
        expect(
            seriesGrowthReflow({ tree, seriesId: "s", layout: LAYOUT })
        ).toBeNull();
    });

    it("returns null when the parent is a free-layout container", () => {
        const tree = treeWith({ parentLayout: "free", games: 5 });
        expect(
            seriesGrowthReflow({ tree, seriesId: "s", layout: LAYOUT })
        ).toBeNull();
    });

    it("returns null when the series is not in the tree", () => {
        const tree = treeWith({ games: 3 });
        expect(
            seriesGrowthReflow({ tree, seriesId: "gone", layout: LAYOUT })
        ).toBeNull();
    });

    it("displaces a Card the grown series now covers, and leaves the series put", () => {
        // A Bo5 at col 0 spans cols 0-4; a Card sits at col 3, inside that span.
        const tree = treeWith({
            games: 5,
            cards: [{ id: "c", row: 0, col: 3 }]
        });

        const result = seriesGrowthReflow({ tree, seriesId: "s", layout: LAYOUT });

        expect(result).not.toBeNull();
        expect(result?.parentId).toBe("p");
        // Only the displaced Card is written — the grown node does not move.
        expect(result?.placements.map((p) => p.id)).toEqual(["c"]);
    });

    it("returns null when nothing collides", () => {
        // A Bo3 spans cols 0-2 and is still TWO rows tall — the vertical half
        // of the overhang is parked in design §6.0a — so the clear row is 2,
        // not 1. A Card at row 1 would genuinely be under the series.
        const tree = treeWith({
            games: 3,
            cards: [{ id: "c", row: 2, col: 0 }]
        });
        expect(
            seriesGrowthReflow({ tree, seriesId: "s", layout: LAYOUT })
        ).toBeNull();
    });

    // §6.0a LANDED. A series used to stamp a second row of pure chrome, so a
    // Card directly beneath one was displaced by a growth that never reached
    // it. Rows auto-size now, the series claims only its own row, and the Card
    // below is left alone. This assertion is the inverse of the one it
    // replaces, deliberately — it was pinned to make the change visible.
    it("no longer covers the row beneath it — that was chrome (§6.0a rule 1)", () => {
        const tree = treeWith({
            games: 3,
            cards: [{ id: "c", row: 1, col: 0 }]
        });
        expect(seriesGrowthReflow({ tree, seriesId: "s", layout: LAYOUT })).toBeNull();
    });

    // The whole point of the slice: at Bo3 the Card at col 3 is clear, and the
    // SAME tree at Bo5 displaces it. Under the retired 2x4 contract a Bo3
    // already covered col 3, so this pins the new span.
    it("leaves col 3 alone at Bo3 and displaces it at Bo5", () => {
        const at = (games: number) =>
            seriesGrowthReflow({
                tree: treeWith({ games, cards: [{ id: "c", row: 0, col: 3 }] }),
                seriesId: "s",
                layout: LAYOUT
            });

        expect(at(3)).toBeNull();
        expect(at(5)?.placements.map((p) => p.id)).toEqual(["c"]);
    });
});
