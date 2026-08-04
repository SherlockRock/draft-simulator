import { Viewport } from "./schemas";

export type ScreenPoint = { x: number; y: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

export const clampZoom = (zoom: number): number =>
    Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

/**
 * Level-of-detail thresholds for panning at low zoom.
 *
 * Below LOD_ENTER_ZOOM a card's 20 slots stop painting and are replaced by a flat
 * icon mosaic, and the dot grid stops painting. Measured in Chrome at zoom 0.20,
 * 40 cards on screen, 164Hz (6.1ms budget), three interleaved reps per row:
 *
 *   real slots + dot grid    115 fps    p95 12.2ms   ~1 frame in 5 dropped
 *   mosaic     + dot grid    132 fps    p95 12.2ms
 *   mosaic     + no grid     164 fps    p95  6.1ms   ~0 dropped
 *
 * The two levers are additive and together reach the vsync budget. The grid is the
 * bigger half: the cost is having ANY repeating background-image on a translating
 * layer, and it is unfixable by cheaper means — a coarser pitch, an opaque layer
 * and a pre-rasterised bitmap tile were each measured at zero.
 *
 * EXIT is above ENTER so the state machine has hysteresis: without a band, hovering
 * on the threshold swaps every card's interior back and forth on alternate frames.
 */
export const LOD_ENTER_ZOOM = 0.3;
export const LOD_EXIT_ZOOM = 0.345;

/**
 * Hysteresis state machine for the LOD. Pure so it can be tested directly; the
 * canvas wraps it in a `createMemo` that feeds the previous value back in.
 *
 * Anything that is not a usable zoom holds the current state rather than flipping
 * it — a transient NaN must not swap 40 card interiors.
 */
export const nextLodState = (previous: boolean, zoom: number): boolean => {
    if (!Number.isFinite(zoom) || zoom <= 0) return previous;
    if (!previous && zoom < LOD_ENTER_ZOOM) return true;
    if (previous && zoom > LOD_EXIT_ZOOM) return false;
    return previous;
};

/**
 * Width, in world px, for a stroke that must stay a constant DEVICE size.
 *
 * Everything inside `.canvas-world` is multiplied by `scale(zoom)`, so a stroke
 * authored at N css px paints at `N * zoom` device px. Below roughly one device
 * pixel it rasterises inconsistently — edges round away independently, so the
 * stroke thins on some sides and disappears on others rather than fading. At
 * MIN_ZOOM a 4px highlight ring is 0.4 device px and a 1px border is 0.1.
 *
 * Dividing by zoom cancels the layer scale. Applies to any hairline UI
 * affordance drawn in world space — highlight rings, hairline borders — but NOT
 * to content, which should scale with the canvas like everything else.
 *
 * An unusable zoom returns the authored width: a transient NaN or a zoom of 0
 * must not produce an Infinity-wide ring.
 */
export const screenConstantPx = (cssPx: number, zoom: number): number =>
    Number.isFinite(zoom) && zoom > 0 ? cssPx / zoom : cssPx;

/**
 * The CSS transform for the single `.canvas-world` layer.
 *
 * This replaces the per-element math every card and group used to run. An
 * element at `left: wx; top: wy` inside this layer lands at `(w - vp) * zoom`,
 * which is exactly what `left: (wx - vp.x) * zoom` plus `scale(zoom)` at
 * `transform-origin: top left` produced before. viewport.test.ts pins that
 * equivalence.
 */
export const worldTransform = (vp: Viewport): string =>
    `translate3d(${-vp.x * vp.zoom}px, ${-vp.y * vp.zoom}px, 0) scale(${vp.zoom})`;

/** The world point currently rendered at a container-relative screen point. */
export const worldAt = (vp: Viewport, anchor: ScreenPoint): ScreenPoint => ({
    x: anchor.x / vp.zoom + vp.x,
    y: anchor.y / vp.zoom + vp.y
});

/**
 * Zoom while keeping the world point under `anchor` visually fixed at `anchor`.
 *
 * `anchor` is CONTAINER-RELATIVE screen px — the same convention screenToWorld
 * uses (it subtracts the container rect). Passing raw clientX/clientY is wrong
 * whenever the canvas does not start at the viewport origin.
 *
 * Returns the input object identity unchanged when the zoom is unchanged, so a
 * wheel event at a clamp cannot manufacture float drift for no visual change.
 */
export const zoomAt = (vp: Viewport, nextZoom: number, anchor: ScreenPoint): Viewport => {
    if (nextZoom === vp.zoom) return vp;
    const world = worldAt(vp, anchor);
    return {
        zoom: nextZoom,
        x: world.x - anchor.x / nextZoom,
        y: world.y - anchor.y / nextZoom
    };
};
