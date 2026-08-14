import { describe, expect, it } from "vitest";
import { RESIZE_HANDLE_SCREEN_PX, resizeHandleWorldPx } from "./resizeHandle";
import { MIN_ANNOTATION_HEIGHT, MIN_ANNOTATION_WIDTH } from "./annotationSize";
import { MIN_ZOOM } from "./viewport";

/** A roomy element, so the cap never binds and only the zoom rule is on show. */
const ROOMY = 10000;

describe("resizeHandleWorldPx", () => {
    it("is the authored target at zoom 1", () => {
        expect(resizeHandleWorldPx(1, ROOMY)).toBe(RESIZE_HANDLE_SCREEN_PX);
    });

    /**
     * THE POINT OF THE CHANGE. The handle must stay the same size ON SCREEN as
     * the canvas zooms, because the pointer does not get more precise.
     *
     * Asserted as `world * zoom === screen` rather than against a literal, so
     * this cannot pass by coincidence at one particular zoom.
     */
    it("holds a constant on-screen size across the whole zoom range", () => {
        for (const zoom of [0.25, 0.4, 0.5, 1, 2, 5]) {
            expect(resizeHandleWorldPx(zoom, ROOMY) * zoom).toBeCloseTo(
                RESIZE_HANDLE_SCREEN_PX
            );
        }
    });

    // The Group's shipped rule, for contrast: a fixed world size is the thing
    // being replaced, and at MIN_ZOOM it is not a pointer target at all.
    it("beats a fixed world-px handle at low zoom", () => {
        const fixedWorld16 = 16;
        expect(fixedWorld16 * MIN_ZOOM).toBeLessThan(2);
        expect(resizeHandleWorldPx(0.3, ROOMY)).toBeGreaterThan(fixedWorld16);
    });

    /**
     * ⚠️ THE CAP, and it is not a rounding detail — it is the bug the annotation
     * handle shipped with. `screenConstantPx(12, 0.1)` is 120 world px, against
     * a note whose MINIMUM is 56x40. The handle covered the entire note, which
     * takes the drag and the selection with it.
     */
    it("never grows past half the element's shortest side", () => {
        const shortest = Math.min(MIN_ANNOTATION_WIDTH, MIN_ANNOTATION_HEIGHT);
        const handle = resizeHandleWorldPx(MIN_ZOOM, shortest);
        expect(handle).toBe(shortest / 2);
        expect(handle).toBeLessThan(shortest);
    });

    it("caps against the SHORTEST side, not the longest", () => {
        // A wide, short note — the height is what the handle can swallow, so a
        // rule reading the width would happily cover it.
        expect(resizeHandleWorldPx(MIN_ZOOM, MIN_ANNOTATION_HEIGHT)).toBe(
            MIN_ANNOTATION_HEIGHT / 2
        );
    });

    /**
     * ⚠️ THE REGRESSION THIS HELPER EXISTS TO AVOID, and it was found by this
     * test failing against a first draft that capped at a THIRD.
     *
     * The cap must not bite at the zooms the complaint came from. On a standard
     * 120px-tall note a third is 40 world px at 0.25 zoom — 10 screen px, which
     * is SMALLER than the 12 the old handle gave. The "fix" would have made the
     * reported case worse while every other test stayed green.
     */
    it("is never smaller than the 12px handle it replaces, at usable zooms", () => {
        const SHIPPED_SCREEN_PX = 12;
        const noteHeight = 120;
        for (const zoom of [0.25, 0.4, 0.5, 1, 2]) {
            const screenPx = resizeHandleWorldPx(zoom, noteHeight) * zoom;
            expect(screenPx).toBeGreaterThanOrEqual(SHIPPED_SCREEN_PX);
        }
    });

    it("leaves a normal note on the screen-constant rule when zoomed out", () => {
        expect(resizeHandleWorldPx(0.4, 120)).toBe(RESIZE_HANDLE_SCREEN_PX / 0.4);
    });

    it("falls back to the screen-constant size when the element size is unusable", () => {
        for (const bad of [0, -50, Number.NaN]) {
            expect(resizeHandleWorldPx(1, bad)).toBe(RESIZE_HANDLE_SCREEN_PX);
        }
    });

    // Mirrors `screenConstantPx`'s own guard: a transient zoom of 0 must not
    // produce an Infinity-wide handle.
    it("survives a degenerate zoom", () => {
        expect(resizeHandleWorldPx(0, ROOMY)).toBe(RESIZE_HANDLE_SCREEN_PX);
        expect(resizeHandleWorldPx(Number.NaN, ROOMY)).toBe(RESIZE_HANDLE_SCREEN_PX);
    });
});
