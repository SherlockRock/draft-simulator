import { screenConstantPx } from "./viewport";

/**
 * A bottom-LEFT resize: the note's right edge is anchored, so width and
 * `positionX` move together and in opposite directions.
 *
 * **The invariant is that `positionX + width` never changes**, and it has to
 * hold through the min-width clamp too — that is the case a naive
 * implementation gets wrong, by clamping the width and leaving `positionX`
 * free, which walks the anchored edge leftward one frame at a time.
 *
 * Mirrors `CustomGroupContainer`'s `edge === "left"` branch, which is the same
 * `startPositionX + (startWidth - width)` shape. Extracted rather than copied
 * because component internals are invisible to the suite here — no jsdom, by
 * maintainer ruling — so this is the only layer where the arithmetic can be
 * proven at all.
 */
export const resizeFromLeft = (args: {
    startPositionX: number;
    startWidth: number;
    deltaX: number;
    minWidth: number;
}): { positionX: number; width: number } => {
    const width = Math.max(args.minWidth, args.startWidth - args.deltaX);
    return {
        positionX: args.startPositionX + (args.startWidth - width),
        width
    };
};

/**
 * A comfortable pointer target for a corner resize grip, in css px.
 *
 * A hit target is a property of the HAND, not of the canvas — the pointer does
 * not get more precise because the user zoomed out — so this is authored in
 * screen px and converted per zoom by `resizeHandleWorldPx`.
 *
 * 20 rather than the 12 the annotation handle shipped with: 12 is grabbable
 * when you already know exactly where it is, which is the case the author is
 * always in and the user never is.
 */
export const RESIZE_HANDLE_SCREEN_PX = 20;

/**
 * How much of an element's shortest side a corner handle may claim.
 *
 * The cap is what stops a screen-constant handle eating the thing it resizes.
 * `MIN_ZOOM` is 0.1, so an uncapped 20px target is 200 WORLD px — against a
 * `MIN_ANNOTATION_WIDTH`/`HEIGHT` of 56x40. The handle would cover the whole
 * note several times over and take the drag and the selection with it.
 *
 * ⚠️ DELIBERATELY LOOSE, and a third was tried and rejected. The cap and the
 * target size pull against each other, and the cap binds exactly where the
 * complaint came from: on a 120px-tall note at 0.25 zoom, a third is 40 world
 * px — **10 screen px, WORSE than the 12 this replaces**. A half keeps every
 * ordinary note on the screen-constant rule down to 0.25 and only takes over
 * where the alternative is a handle wider than the note.
 *
 * So this is a SAFETY BOUND, not a layout rule. Raise this divisor and you
 * silently re-break the case it was written for; the test names that trade-off.
 */
const SHORTEST_SIDE_DIVISOR = 2;

/**
 * The side length of a square corner resize handle, in WORLD px.
 *
 * Two rules fight, and both have to hold:
 *
 * - **Screen-constant.** Everything in `.canvas-world` is under `scale(zoom)`,
 *   so a handle authored in world px shrinks as you zoom out — the Group's
 *   `h-4 w-4` is 1.6 screen px at `MIN_ZOOM`, which is not a target at all.
 *   Dividing by zoom cancels the layer scale, exactly as `screenConstantPx`
 *   does for hairline strokes.
 * - **Never larger than a third of the element.** Screen-constant alone
 *   inverts the bug at low zoom, where the handle grows in world space until
 *   it is bigger than what it resizes.
 *
 * Below the crossover the handle IS smaller than the ideal target, and that is
 * the honest answer rather than a failure: a 40px-tall note at 0.1 zoom is 4
 * screen px, and no handle on it can be 20. It degrades to a third of a very
 * small thing instead of covering it.
 *
 * `shortestSideWorldPx` is the RENDERED size, not the stored one — inside a
 * grid a note paints at its snapped footprint, and the handle sits on the
 * painted corner.
 */
export const resizeHandleWorldPx = (
    zoom: number,
    shortestSideWorldPx: number,
    screenPx: number = RESIZE_HANDLE_SCREEN_PX
): number => {
    const ideal = screenConstantPx(screenPx, zoom);
    if (!Number.isFinite(shortestSideWorldPx) || shortestSideWorldPx <= 0) {
        return ideal;
    }
    return Math.min(ideal, shortestSideWorldPx / SHORTEST_SIDE_DIVISOR);
};
