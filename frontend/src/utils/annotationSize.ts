import type { CanvasAnnotation } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";
import { cardWidth } from "./helpers";

export const MIN_ANNOTATION_WIDTH = 56;
export const MIN_ANNOTATION_HEIGHT = 40;

/** A new annotation is one grid cell wide in the active card layout. */
export const defaultAnnotationSize = (
    layout: CardLayout
): { width: number; height: number } => ({
    width: cardWidth(layout),
    height: 120
});

/**
 * The hand-set floor for auto-sizing. Stored rendered dimensions are excluded:
 * auto-fit writes height, so using height here would make growth ratchet.
 */
export const annotationFloor = (
    annotation: Pick<CanvasAnnotation, "manualWidth" | "manualHeight">
): { width: number; height: number } => ({
    width: annotation.manualWidth ?? 0,
    height: annotation.manualHeight ?? 0
});

/** Resolves measured content height against the resize minimum and manual floor. */
export const autoFitHeight = (args: { measured: number; floor: number }): number => {
    const floor = Math.max(MIN_ANNOTATION_HEIGHT, args.floor);
    if (!Number.isFinite(args.measured)) return floor;
    return Math.max(floor, args.measured);
};
