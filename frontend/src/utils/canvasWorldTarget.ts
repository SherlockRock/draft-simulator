export const CANVAS_WORLD_SURFACE_SELECTOR =
    ".canvas-background, .canvas-world, .group-container, .canvas-card, .canvas-annotation";

export const isCanvasWorldElement = (target: Pick<Element, "closest">) =>
    target.closest(CANVAS_WORLD_SURFACE_SELECTOR) !== null;
