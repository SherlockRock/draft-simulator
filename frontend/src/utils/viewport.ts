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
 * Smallest ON-SCREEN text size worth painting, in post-transform css px.
 *
 * Below this the glyphs are noise, and a solid colour block reads the note's
 * presence and category faster than an unreadable smear does.
 */
export const LEGIBILITY_FLOOR_PX = 6;

/**
 * Exit is above enter, for exactly the reason `LOD_EXIT_ZOOM` is above
 * `LOD_ENTER_ZOOM`: without a band, hovering on the threshold swaps every
 * note's interior back and forth on alternate frames.
 *
 * It is the same 1.15 the LOD band uses (0.345 / 0.3), so the two agree by
 * construction rather than by coincidence — and for the DEFAULT `md` preset
 * the numbers land on top of each other exactly (6/20 = 0.3, 6.9/20 = 0.345).
 * That coincidence is real but load-bearing on nothing: change the floor or a
 * preset and it dissolves without breaking anything.
 */
export const LEGIBILITY_EXIT_RATIO = 1.15;

/**
 * Per-annotation legibility state machine — `true` means COLLAPSED to a colour
 * block (design §4). Pure, so it can be tested directly.
 *
 * Parameterized on the font size, which is why `nextLodState` cannot be reused:
 * that one takes `(previous, zoom)` against fixed ZOOM thresholds and would give
 * every preset the same cutoff — collapsing the large region labels `fontSize`
 * exists to support at exactly the zoom where they earn their keep. Concretely
 * the four presets collapse at four different zooms: 0.43, 0.3, 0.19, 0.11.
 *
 * This COMPOSES with the global `lodActive()` rather than replacing it; global
 * LOD drives Cards and the dot grid, and a blanket cutoff here would defeat the
 * feature. Champion icons always render regardless, and because the annotation's
 * size is STORED, the collapse is paint-only and can never reflow anything.
 *
 * ⚠️ Three zones, and only the BAND consults `previous`. Guarding the outer two
 * on the previous state as well (`!previous && …` / `previous && …`, the shape
 * `nextLodState` above is written in) cannot change a single answer: below the
 * floor the result is `true` from either state, above the exit it is `false`
 * from either. Those guards read as though the state matters in all three zones
 * when it matters in exactly one, so they are deliberately absent here. Tests
 * pin both outer zones from BOTH inbound states to keep them absent.
 */
export const nextLegibleState = (
    previous: boolean,
    fontSizePx: number,
    zoom: number
): boolean => {
    if (!Number.isFinite(zoom) || zoom <= 0) return previous;
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return previous;
    const onScreen = fontSizePx * zoom;
    if (onScreen < LEGIBILITY_FLOOR_PX) return true;
    if (onScreen > LEGIBILITY_FLOOR_PX * LEGIBILITY_EXIT_RATIO) return false;
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

/** Thinnest a world-space stroke may render, in post-transform css px. */
export const MIN_VISIBLE_STROKE_PX = 2;

/**
 * Width, in world px, for a stroke that should scale with the canvas like the
 * content it decorates, but never thin out to the point of disappearing.
 *
 * Rendered width is `max(basePx * zoom, minDevicePx)`. Above the crossover it is
 * exactly the authored width — a highlight keeps the weight it has always had
 * when zoomed in — and below it the stroke holds at the floor instead of
 * rasterising away edge-by-edge.
 *
 * This is the middle ground between the two obvious options, both of which are
 * wrong on their own: a plain css width vanishes at low zoom, and
 * screenConstantPx (constant on-screen size) stays legible but reads as absurdly
 * heavy when the card it surrounds is 34px wide. Prefer this for anything that
 * decorates content; prefer screenConstantPx only for chrome that is genuinely
 * zoom-independent, like the action buttons' hairline borders.
 */
export const scaledStrokePx = (
    basePx: number,
    zoom: number,
    minDevicePx: number = MIN_VISIBLE_STROKE_PX
): number => {
    if (!Number.isFinite(zoom) || zoom <= 0) return basePx;
    return Math.max(basePx, minDevicePx / zoom);
};

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
