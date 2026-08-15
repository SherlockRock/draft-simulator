import { describe, expect, it } from "vitest";
import {
    LOCK_BADGE_LABEL_MIN_SCREEN_PX,
    LOCK_BADGE_TEXT_SCREEN_PX,
    lockBadgeMode
} from "./annotationLockBadge";
import { MIN_ANNOTATION_WIDTH } from "./annotationSize";
import { MIN_ZOOM } from "./viewport";

describe("lockBadgeMode", () => {
    it("labels a note with room for the words", () => {
        expect(lockBadgeMode(1, 380)).toBe("label");
    });

    // The badge is screen-constant, so what decides this is the note's width
    // ON SCREEN — the same note is a label zoomed in and a dot zoomed out.
    it("drops to a dot once the same note is too narrow on screen", () => {
        expect(lockBadgeMode(0.5, 200)).toBe("label");
        expect(lockBadgeMode(0.2, 200)).toBe("dot");
    });

    // A note at the resize floor cannot hold the words at ANY zoom, because
    // the badge no longer shrinks with the note.
    it("drops to a dot for a minimum-width note even at full zoom", () => {
        expect(lockBadgeMode(1, MIN_ANNOTATION_WIDTH)).toBe("dot");
    });

    it("labels exactly at the threshold and dots just below it", () => {
        expect(lockBadgeMode(1, LOCK_BADGE_LABEL_MIN_SCREEN_PX)).toBe("label");
        expect(lockBadgeMode(1, LOCK_BADGE_LABEL_MIN_SCREEN_PX - 1)).toBe("dot");
    });

    it("still decides at the extremes of the zoom range", () => {
        expect(lockBadgeMode(MIN_ZOOM, 380)).toBe("dot");
        expect(lockBadgeMode(5, MIN_ANNOTATION_WIDTH)).toBe("label");
    });

    // A transient NaN must not silently degrade the only user-facing signal
    // the lock has. Probed from BOTH sides: an unusable number in either
    // argument, where the arithmetic alone would have produced NaN >= n, i.e.
    // `false`, i.e. a dot.
    it("holds the label on an unusable zoom or width", () => {
        expect(lockBadgeMode(0, 380)).toBe("label");
        expect(lockBadgeMode(-1, 380)).toBe("label");
        expect(lockBadgeMode(Number.NaN, 380)).toBe("label");
        expect(lockBadgeMode(Number.POSITIVE_INFINITY, 380)).toBe("label");
        expect(lockBadgeMode(1, Number.NaN)).toBe("label");
        expect(lockBadgeMode(1, 0)).toBe("label");
    });

    it("keeps the label legible at the smallest zoom that still shows one", () => {
        // Whatever the constants are, a label must never be painted below the
        // legibility floor the rest of the canvas honours.
        expect(LOCK_BADGE_TEXT_SCREEN_PX).toBeGreaterThanOrEqual(6);
    });
});
