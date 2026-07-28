import { Viewport } from "./schemas";

export type ScreenPoint = { x: number; y: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

export const clampZoom = (zoom: number): number =>
    Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

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
export const zoomAt = (
    vp: Viewport,
    nextZoom: number,
    anchor: ScreenPoint
): Viewport => {
    if (nextZoom === vp.zoom) return vp;
    const world = worldAt(vp, anchor);
    return {
        zoom: nextZoom,
        x: world.x - anchor.x / nextZoom,
        y: world.y - anchor.y / nextZoom
    };
};
