import { CanvasAnnotation, CanvasDraft, CanvasGroup, AnchorType } from "./schemas";
import { AnchorPosition } from "./types";
import { CardLayout } from "./canvasCardLayout";

const CARD_DIMENSIONS: Record<CardLayout, { width: number; height: number }> = {
    vertical: { width: 380, height: 600 },
    horizontal: { width: 700, height: 384 },
    wide: { width: 700, height: 860 },
    "wide-draft-order": { width: 700, height: 960 },
    compact: { width: 380, height: 432 },
    "draft-order": { width: 420, height: 728 }
};

export const cardHeight = (cardLayout: CardLayout) => {
    return CARD_DIMENSIONS[cardLayout].height;
};

export const cardWidth = (cardLayout: CardLayout) => {
    return CARD_DIMENSIONS[cardLayout].width;
};

/**
 * Calculates the world coordinates for an anchor point.
 * When a group is provided, the draft's coordinates are treated as group-relative
 * and offset by the group's world position (plus header height).
 */
export const getAnchorWorldPosition = (
    draft: CanvasDraft,
    anchorType: AnchorType,
    cardLayout: CardLayout,
    group?: CanvasGroup | null
): AnchorPosition => {
    let baseX = draft.positionX;
    let baseY = draft.positionY;

    if (group) {
        baseX += group.positionX;
        baseY += group.positionY;
    }

    const currentWidth = cardWidth(cardLayout);
    const currentHeight = cardHeight(cardLayout);

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
 * Calculates the world coordinates for a group's anchor point,
 * using the group's position, width, and height.
 */
export const getGroupAnchorWorldPosition = (
    group: CanvasGroup,
    anchorType: AnchorType
): AnchorPosition => {
    const baseX = group.positionX;
    const baseY = group.positionY;
    const w = group.width ?? 400;
    const h = group.height ?? 200;

    switch (anchorType) {
        case "top":
            return { x: baseX + w / 2, y: baseY };
        case "bottom":
            return { x: baseX + w / 2, y: baseY + h };
        case "left":
            return { x: baseX, y: baseY + h / 2 };
        case "right":
            return { x: baseX + w, y: baseY + h / 2 };
        default:
            return { x: baseX + w / 2, y: baseY + h / 2 };
    }
};

/**
 * World coordinates for an annotation's anchor point.
 *
 * Four anchors like a Card (design D10). The helper stays pure and resolves
 * whatever rect it is handed.
 *
 * ⚠️ Connection callers hand it the PAINTED rect (`annotationConnectionRect`),
 * which inside a grid differs from the stored one — a note stored 380x120 can
 * paint 700x860. This REVERSES the rule this docblock carried when the geometry
 * landed, on a maintainer ruling (2026-08-14), and the reversed rule's objection
 * was true rather than wrong: an anchor that follows the painted size DOES move
 * every endpoint on that note when an unrelated row grows, or when the note
 * enters or leaves a grid. It was judged the smaller cost, because the
 * alternative puts the dot on the visible border and the line up to 740px
 * inside the note — where D8's paint order hides it. Do not "restore" the
 * stored rect here without re-opening that ruling.
 *
 * ⚠️ No header term, and that is deliberate. A grouped note PAINTS at
 * `positionY - CUSTOM_GROUP_HEADER_HEIGHT` (`annotationRenderTop`), and a
 * grouped Card does exactly the same (`CanvasCard.tsx:653`) — that subtraction
 * cancels the container's content box, which already begins one header below
 * the container's own origin. Adding the header back here would double-count
 * it and float every grouped note's line one header above the note. The Card
 * path (`getAnchorWorldPosition` above) omits it for the same reason.
 *
 * Takes only the rect rather than a whole `CanvasAnnotation`, so callers that
 * have a size and a position — previews, drag ghosts — need not fabricate a row.
 */
export const getAnnotationAnchorWorldPosition = (
    annotation: Pick<CanvasAnnotation, "positionX" | "positionY" | "width" | "height">,
    anchorType: AnchorType,
    group?: Pick<CanvasGroup, "positionX" | "positionY"> | null
): AnchorPosition => {
    const baseX = annotation.positionX + (group?.positionX ?? 0);
    const baseY = annotation.positionY + (group?.positionY ?? 0);
    const w = annotation.width;
    const h = annotation.height;

    switch (anchorType) {
        case "top":
            return { x: baseX + w / 2, y: baseY };
        case "bottom":
            return { x: baseX + w / 2, y: baseY + h };
        case "left":
            return { x: baseX, y: baseY + h / 2 };
        case "right":
            return { x: baseX + w, y: baseY + h / 2 };
        default:
            return { x: baseX + w / 2, y: baseY + h / 2 };
    }
};

/**
 * The structural frame border both container components paint (`border-2` on
 * the root of `CustomGroupContainer` and `SeriesGroupContainer`).
 *
 * It is a LAYOUT border, not a ring: a Tailwind ring is a world-space
 * box-shadow and vanishes below one device pixel at `MIN_ZOOM = 0.1`
 * (`viewport.ts`), which is exactly why these frames are not rings. Proposed
 * and rejected twice — do not "fix" the inset table by changing it.
 *
 * It matters to `canvasTree.insetOf` because it displaces a container's
 * content: a child Card is positioned inside its parent's padding box, so it
 * picks up the PARENT's border, while a child Group renders at world level and
 * its own content picks up its OWN. Both are one border width, which is why the
 * term cancels in every difference `gridRows.ts` takes.
 *
 * Declared here rather than in `gridLayout.ts` — which re-exports it — because
 * `gridLayout` already imports `cardWidth`/`cardHeight` from this module and
 * the reverse import would be a cycle.
 */
export const GROUP_BORDER_WIDTH = 2;

// Series group layout constants (must match SeriesGroupContainer.tsx)
export const SERIES_HEADER_HEIGHT = 56;
// Horizontal padding is ZERO so a Bo-N series measures exactly N grid columns:
// SERIES_CARD_GAP and GRID_CELL_GAP are both 24, so the games then land on the
// grid's own column rhythm (design §6, superseding block).
export const SERIES_PADDING_X = 0;
export const SERIES_PADDING_Y = 20;
export const SERIES_CARD_GAP = 24;

/**
 * The per-game team-control block that sits ABOVE each series game's draft
 * Card — the two side panels plus the swap button, plus the `gap-2` beneath
 * them (`SeriesGroupContainer`'s `flex flex-col gap-2` game column).
 *
 * MEASURED against a rendered container, not derived from the markup: the
 * block's height is intrinsic (button padding, text metrics, `border p-2`).
 * Browser-measured 2026-08-09 at zoom 1 on a three-game series, in all six
 * card layouts: the block itself is 86.5 and the column's `gap-2` adds 8. Every
 * layout agreed, and `2*GROUP_BORDER_WIDTH + SERIES_HEADER_HEIGHT +
 * 2*SERIES_PADDING_Y + this + cardHeight` reproduced the painted frame height
 * exactly in each. If the series interior changes, RE-MEASURE — the two
 * consumers below are continuous inputs to the §6.0a row model and are no
 * longer forgiving.
 *
 * It arrived in e442845 (2026-06-29) and neither consumer was updated, which
 * `spanFor`'s ceil hid for six weeks: `spanFor(96+ch, ch, 24)` and
 * `spanFor(192+ch, ch, 24)` are both 2 in all six card layouts, so no column
 * span ever changed.
 */
export const SERIES_GAME_CONTROLS_HEIGHT = 94.5;

/**
 * Computes the pixel dimensions of a series group container
 * based on the number of drafts and the current layout toggle.
 *
 * The height is the frame's BORDER BOX, matching what a custom Group's stored
 * `width`/`height` mean: the series root declares no explicit height, so its
 * `border-2` adds on both edges. Retiring that 4px here is the vertical half of
 * §6's long-standing discrepancy; the horizontal half stays open against 5a-6.
 */
export const getSeriesGroupDimensions = (
    draftCount: number,
    cardLayout: CardLayout
): { width: number; height: number } => {
    const cw = cardWidth(cardLayout);
    const ch = cardHeight(cardLayout);
    return {
        width:
            2 * SERIES_PADDING_X +
            draftCount * cw +
            Math.max(0, draftCount - 1) * SERIES_CARD_GAP,
        height:
            2 * GROUP_BORDER_WIDTH +
            SERIES_HEADER_HEIGHT +
            2 * SERIES_PADDING_Y +
            SERIES_GAME_CONTROLS_HEIGHT +
            ch
    };
};

/**
 * Computes the world-coordinate top-left corner of a draft card
 * inside a series group, based on its sorted index in the group.
 *
 * The `y` composite here is MIRRORED on three runtimes — this helper, the
 * backend's `nextSeriesCardOrigin` and its two literal seeds, and
 * `useLocalCanvasMutations`. They must move together or a Card jumps the moment
 * it leaves a series, because the stored value is what the promote-on-delete
 * and drag-out-of-series paths read back.
 */
export const getSeriesDraftWorldPosition = (
    group: CanvasGroup,
    draftIndex: number,
    cardLayout: CardLayout
): { x: number; y: number } => {
    const cw = cardWidth(cardLayout);
    return {
        x: group.positionX + SERIES_PADDING_X + draftIndex * (cw + SERIES_CARD_GAP),
        y:
            group.positionY +
            GROUP_BORDER_WIDTH +
            SERIES_HEADER_HEIGHT +
            SERIES_PADDING_Y +
            SERIES_GAME_CONTROLS_HEIGHT
    };
};

/**
 * Gets the anchor world position for a draft inside a series group.
 * Uses computed layout position instead of stored positionX/Y.
 */
export const getSeriesDraftAnchorWorldPosition = (
    group: CanvasGroup,
    draftIndex: number,
    anchorType: AnchorType,
    cardLayout: CardLayout
): AnchorPosition => {
    const base = getSeriesDraftWorldPosition(group, draftIndex, cardLayout);
    const cw = cardWidth(cardLayout);
    const ch = cardHeight(cardLayout);

    switch (anchorType) {
        case "top":
            return { x: base.x + cw / 2, y: base.y };
        case "bottom":
            return { x: base.x + cw / 2, y: base.y + ch };
        case "left":
            return { x: base.x, y: base.y + ch / 2 };
        case "right":
            return { x: base.x + cw, y: base.y + ch / 2 };
        default:
            return { x: base.x + cw / 2, y: base.y + ch / 2 };
    }
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
