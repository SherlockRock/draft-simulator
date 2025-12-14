import { CanvasDraft, AnchorType, Viewport, AnchorPosition } from "./types";

export const cardHeight = (layoutToggle: boolean) => (layoutToggle ? 297 : 500);
export const cardWidth = (layoutToggle: boolean) => (layoutToggle ? 700 : 350);

/**
 * Calculates the world coordinates for an anchor point
 */
export const getAnchorWorldPosition = (
    draft: CanvasDraft,
    anchorType: AnchorType,
    layoutToggle: boolean
): AnchorPosition => {
    const baseX = draft.positionX;
    const baseY = draft.positionY;

    const currentWidth = cardWidth(layoutToggle);
    const currentHeight = cardHeight(layoutToggle);

    switch (anchorType) {
        case "top":
            return {
                x: baseX + currentWidth / 2,
                y: baseY
            };

        case "bottom":
            return {
                x: baseX + currentWidth / 2,
                y: baseY + currentHeight
            };

        case "left":
            return {
                x: baseX,
                y: baseY + currentHeight / 2
            };

        case "right":
            return {
                x: baseX + currentWidth,
                y: baseY + currentHeight / 2
            };

        default:
            return {
                x: baseX + currentWidth / 2,
                y: baseY + currentHeight / 2
            };
    }
};

/**
 * Converts world coordinates to screen coordinates
 */
export const worldToScreen = (
    worldX: number,
    worldY: number,
    viewport: Viewport
): AnchorPosition => {
    return {
        x: (worldX - viewport.x) * viewport.zoom,
        y: (worldY - viewport.y) * viewport.zoom
    };
};

/**
 * Converts screen coordinates to world coordinates
 */
export const screenToWorld = (
    screenX: number,
    screenY: number,
    viewport: Viewport
): AnchorPosition => {
    return {
        x: screenX / viewport.zoom + viewport.x,
        y: screenY / viewport.zoom + viewport.y
    };
};

/**
 * Gets the screen position for an anchor point
 */
export const getAnchorScreenPosition = (
    draft: CanvasDraft,
    anchorType: AnchorType,
    layoutToggle: boolean,
    viewport: Viewport
): AnchorPosition => {
    const worldPos = getAnchorWorldPosition(draft, anchorType, layoutToggle);
    return worldToScreen(worldPos.x, worldPos.y, viewport);
};

/**
 * Calculate distance from point to line segment
 */
export const distanceToLineSegment = (
    point: { x: number; y: number },
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number }
): number => {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;

    if (lenSq !== 0) {
        param = dot / lenSq;
    }

    let xx, yy;

    if (param < 0) {
        xx = lineStart.x;
        yy = lineStart.y;
    } else if (param > 1) {
        xx = lineEnd.x;
        yy = lineEnd.y;
    } else {
        xx = lineStart.x + param * C;
        yy = lineStart.y + param * D;
    }

    const dx = point.x - xx;
    const dy = point.y - yy;

    return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Find closest point on line segment to given point
 */
export const closestPointOnLineSegment = (
    point: { x: number; y: number },
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number }
): { x: number; y: number } => {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;

    if (lenSq !== 0) {
        param = dot / lenSq;
    }

    if (param < 0) {
        return { x: lineStart.x, y: lineStart.y };
    } else if (param > 1) {
        return { x: lineEnd.x, y: lineEnd.y };
    } else {
        return {
            x: lineStart.x + param * C,
            y: lineStart.y + param * D
        };
    }
};
