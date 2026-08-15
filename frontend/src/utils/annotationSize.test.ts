import { describe, expect, it } from "vitest";
import {
    annotationConnectionRect,
    annotationRenderSize,
    annotationFloor,
    autoFitHeight,
    defaultAnnotationSize,
    MIN_ANNOTATION_HEIGHT,
    MIN_ANNOTATION_WIDTH,
    snappedAnnotationSize,
    snapWidthToCells
} from "./annotationSize";
import { GRID_CELL_GAP } from "./gridLayout";
import { rowsOfIndexed } from "./gridRows";
import { cardWidth, cardHeight } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

const LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

describe("annotationConnectionRect", () => {
    it("uses the painted size when snapped and the stored size otherwise", () => {
        const stored = { width: 380, height: 120 };
        const painted = { width: 700, height: 860 };

        expect(annotationConnectionRect(stored, painted)).toBe(painted);
        expect(annotationConnectionRect(stored, null)).toEqual(stored);
    });
});

describe("defaultAnnotationSize", () => {
    it("is one cell wide in every card layout", () => {
        for (const layout of LAYOUTS) {
            expect(defaultAnnotationSize(layout).width).toBe(cardWidth(layout));
        }
    });

    it("is never shorter than the resize minimum", () => {
        expect(defaultAnnotationSize("wide").height).toBeGreaterThanOrEqual(
            MIN_ANNOTATION_HEIGHT
        );
    });
});

describe("autoFitHeight", () => {
    it("grows to the measured content", () => {
        expect(autoFitHeight({ measured: 400, floor: 120 })).toBe(400);
    });

    it("shrinks back when the content shrinks", () => {
        expect(autoFitHeight({ measured: 90, floor: 60 })).toBe(90);
    });

    it("never goes below a hand-set floor", () => {
        expect(autoFitHeight({ measured: 40, floor: 300 })).toBe(300);
    });

    // D7's ratchet regression: height is an auto-fit output, never its floor.
    it("still shrinks a note that auto-fit previously grew", () => {
        const grown = { manualWidth: null, manualHeight: null, height: 400 };

        expect(
            autoFitHeight({ measured: 90, floor: annotationFloor(grown).height })
        ).toBe(90);
    });

    it("respects a hand-set floor on a note auto-fit also grew", () => {
        const grown = { manualWidth: null, manualHeight: 300, height: 400 };

        expect(
            autoFitHeight({ measured: 90, floor: annotationFloor(grown).height })
        ).toBe(300);
    });

    it("never goes below the resize minimum even with no floor", () => {
        expect(autoFitHeight({ measured: 1, floor: 0 })).toBe(MIN_ANNOTATION_HEIGHT);
    });

    it("holds the floor on a non-finite measurement", () => {
        expect(autoFitHeight({ measured: Number.NaN, floor: 200 })).toBe(200);
    });
});

describe("MIN_ANNOTATION_WIDTH", () => {
    it("is small enough for a bare champion icon", () => {
        expect(MIN_ANNOTATION_WIDTH).toBeLessThanOrEqual(64);
    });
});

describe("snapWidthToCells", () => {
    // THE LOAD-BEARING CASE. The handle is seeded from the painted box, which
    // already sits exactly on a cell boundary, so this is what a corner drag's
    // incidental horizontal jitter does. Under `spanFor`'s ceil it would be a
    // whole extra column; under nearest it is nothing.
    it("holds the column against a nudge past the boundary", () => {
        for (const layout of LAYOUTS) {
            const oneCell = cardWidth(layout);
            expect(snapWidthToCells(oneCell + 1, layout)).toBe(oneCell);
            expect(snapWidthToCells(oneCell + 30, layout)).toBe(oneCell);
        }
    });

    it("takes the next column once the drag passes the midpoint", () => {
        const layout = "wide";
        const oneCell = cardWidth(layout);
        const twoCells = oneCell * 2 + GRID_CELL_GAP;
        const midpoint = (oneCell + twoCells) / 2;

        expect(snapWidthToCells(midpoint - 1, layout)).toBe(oneCell);
        expect(snapWidthToCells(midpoint + 1, layout)).toBe(twoCells);
    });

    it("never returns less than one column, however far the drag shrinks", () => {
        for (const layout of LAYOUTS) {
            expect(snapWidthToCells(0, layout)).toBe(cardWidth(layout));
            expect(snapWidthToCells(MIN_ANNOTATION_WIDTH, layout)).toBe(
                cardWidth(layout)
            );
        }
    });

    // Two properties in one: re-snapping is a fixpoint, AND the result is a
    // width `spanFor` agrees needs exactly that many columns. If those two
    // disagreed the stored width and the painted span would drift apart on
    // every successive resize.
    it("is a fixpoint, and agrees with the span the render path derives", () => {
        const layout = "wide";
        const oneCell = cardWidth(layout);
        const threeCells = oneCell * 3 + GRID_CELL_GAP * 2;
        const snapped = snapWidthToCells(threeCells - 40, layout);

        expect(snapped).toBe(threeCells);
        expect(snapWidthToCells(snapped, layout)).toBe(snapped);
        expect(snapped2({ storedWidth: snapped, rowHeight: 120, layout }).width).toBe(
            snapped
        );
    });
});

/**
 * A one-row model, so every WIDTH assertion below reads exactly as it did
 * before the row axis existed. The height half is now the SPANNED extent, so
 * those assertions changed and say so where they did.
 */
const rowOfHeight = (height: number, layout: CardLayout) =>
    rowsOfIndexed(
        [{ id: "note", index: 0, inset: 0, height, sizesRow: true, rowSpan: 1 }],
        layout
    );

const snapped2 = (args: {
    storedWidth: number;
    storedHeight?: number;
    rowHeight: number;
    layout: CardLayout;
}) =>
    snappedAnnotationSize({
        storedWidth: args.storedWidth,
        storedHeight: args.storedHeight ?? args.rowHeight,
        startRow: 0,
        rows: rowOfHeight(args.rowHeight, args.layout),
        layout: args.layout
    });

describe("snappedAnnotationSize", () => {
    // Width snaps to whole cells because span feeds maxChildSpanCols, which can
    // change the Group's effective column count — un-snapped, a 1px resize drag
    // would silently reflow the grid horizontally.
    it("rounds a 1-cell-ish width up to exactly one cell", () => {
        expect(snapped2({ storedWidth: 300, rowHeight: 600, layout: "wide" }).width).toBe(
            700
        );
    });

    it("spans two cells with the gap INSIDE the span", () => {
        expect(snapped2({ storedWidth: 720, rowHeight: 600, layout: "wide" }).width).toBe(
            700 * 2 + GRID_CELL_GAP
        );
    });

    // 1401 is one pixel beyond two bare 700px cells, but still fits two cells
    // because the 24px gap is inside their footprint rather than extra width.
    it("keeps a width inside the two-cell gap boundary at two cells", () => {
        expect(
            snapped2({ storedWidth: 1401, rowHeight: 600, layout: "wide" }).width
        ).toBe(700 * 2 + GRID_CELL_GAP);
    });

    // Was "takes the row's height verbatim". Still verbatim when the note fits
    // its row — which is every note that has not been grown past it.
    it("takes the row's height when the note fits inside it", () => {
        expect(
            snapped2({
                storedWidth: 300,
                storedHeight: 120,
                rowHeight: 860,
                layout: "wide"
            }).height
        ).toBe(860);
    });

    // ⚠️ CONTRACT CHANGED: the further row formerly measured 120px. Under the
    // 2026-08-14 reversal it uses the same cardHeight fallback as an empty row.
    it("covers whole further rows once the note outgrows its own", () => {
        const rows = rowOfHeight(120, "wide");
        const twoRows = 120 + GRID_CELL_GAP + cardHeight("wide");
        expect(
            snappedAnnotationSize({
                storedWidth: 300,
                storedHeight: 121,
                startRow: 0,
                rows,
                layout: "wide"
            }).height
        ).toBe(twoRows);
        // Pinned as a LITERAL, because the previous line defines `twoRows` by
        // the same expression and asserting it against itself proves nothing.
        // 1004 is the number the reversal actually produces in `wide`, against
        // 264 under the 120px ruling. The old contract asserted this sum could
        // never reach a card height; it now deliberately exceeds one.
        expect(twoRows).toBe(1004);
        expect(twoRows).toBeGreaterThan(cardHeight("wide"));
    });

    // No fixpoint: a note that can span is excluded from SIZING rows, so no row
    // height it reads is an output of its own height. Calling this twice with
    // its own output must not drift.
    it("is idempotent — feeding its own output back changes nothing", () => {
        const rows = rowOfHeight(860, "wide");
        const once = snappedAnnotationSize({
            storedWidth: 300,
            storedHeight: 120,
            startRow: 0,
            rows,
            layout: "wide"
        });
        const twice = snappedAnnotationSize({
            storedWidth: once.width,
            storedHeight: once.height,
            startRow: 0,
            rows,
            layout: "wide"
        });
        expect(twice).toEqual(once);
    });

    it("is idempotent across a two-cell span", () => {
        const rows = rowOfHeight(860, "wide");
        const once = snappedAnnotationSize({
            storedWidth: 720,
            storedHeight: 120,
            startRow: 0,
            rows,
            layout: "wide"
        });
        const twice = snappedAnnotationSize({
            storedWidth: once.width,
            storedHeight: once.height,
            startRow: 0,
            rows,
            layout: "wide"
        });
        expect(twice).toEqual(once);
    });

    // D5's accepted cost, pinned: the drift is bounded at ONE cell.
    it("drifts by at most one cell across a layout change", () => {
        const inCompact = snapped2({
            storedWidth: 700,
            storedHeight: 120,
            rowHeight: 432,
            layout: "compact"
        });
        const inWide = snapped2({
            storedWidth: 700,
            storedHeight: 120,
            rowHeight: 860,
            layout: "wide"
        });
        expect(inCompact.width).toBe(380 * 2 + GRID_CELL_GAP);
        expect(inWide.width).toBe(700);
    });
});

describe("annotationRenderSize", () => {
    const rowsWith = (specs: { id: string; height: number }[], index = 0) =>
        rowsOfIndexed(
            specs.map((spec) => ({
                id: spec.id,
                index,
                inset: 0,
                height: spec.height,
                sizesRow: true,
                rowSpan: 1
            })),
            "wide"
        );

    it("derives a resting note's size from its settled row", () => {
        expect(
            annotationRenderSize({
                annotation: { id: "note", width: 56, height: 120 },
                activeAnnotationId: null,
                frozenSize: null,
                settledRows: rowsWith([{ id: "note", height: 384 }]),
                layout: "wide"
            })
        ).toEqual({ width: 700, height: 384 });
    });

    it("keeps the local drag snapshot after the note leaves settled rows", () => {
        const frozenSize = { width: 700, height: 384 };

        expect(
            annotationRenderSize({
                annotation: { id: "note", width: 56, height: 120 },
                activeAnnotationId: "note",
                frozenSize,
                settledRows: [],
                layout: "wide"
            })
        ).toBe(frozenSize);
    });

    it("returns null for an in-flight remote note with no local snapshot", () => {
        expect(
            annotationRenderSize({
                annotation: { id: "note", width: 56, height: 120 },
                activeAnnotationId: null,
                frozenSize: null,
                settledRows: [],
                layout: "wide"
            })
        ).toBeNull();
    });

    it("does not give one active note another note's snapshot", () => {
        expect(
            annotationRenderSize({
                annotation: { id: "other", width: 56, height: 120 },
                activeAnnotationId: "note",
                frozenSize: { width: 700, height: 384 },
                settledRows: rowsWith([{ id: "other", height: 120 }]),
                layout: "wide"
            })
        ).toEqual({ width: 700, height: 120 });
    });

    // ⚠️ CONTRACT CHANGED: the occupied row formerly painted at 120px; the
    // reversal makes it paint at the cardHeight fallback.
    it("paints the spanned band for a note grown past its row", () => {
        expect(
            annotationRenderSize({
                annotation: { id: "note", width: 56, height: 200 },
                activeAnnotationId: null,
                frozenSize: null,
                settledRows: rowsWith([{ id: "note", height: 120 }]),
                layout: "wide"
            })
        ).toEqual({
            width: 700,
            height: 120 + GRID_CELL_GAP + cardHeight("wide")
        });
    });
});
