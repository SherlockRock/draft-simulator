import { describe, expect, it } from "vitest";
import {
    annotationFloor,
    autoFitHeight,
    defaultAnnotationSize,
    MIN_ANNOTATION_HEIGHT,
    MIN_ANNOTATION_WIDTH
} from "./annotationSize";
import { cardWidth } from "./helpers";
import type { CardLayout } from "./canvasCardLayout";

const LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

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
