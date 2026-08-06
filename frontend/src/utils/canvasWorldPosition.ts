import type { CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";
import { getSeriesDraftWorldPosition } from "./helpers";

/**
 * Where a Card's top-left corner actually sits in world space.
 *
 * A Card's stored positionX/Y are relative to its immediate container, and a
 * series is a special case on top of that: its games are laid out from
 * seriesIndex, so their stored coordinates are ignored entirely (see
 * ADR-0006 and the recursive-groups design §5.1).
 *
 * This lives in one place because it did not used to: Canvas.tsx and
 * CanvasWorkflow.tsx each carried their own copy and both omitted the series
 * header + padding from the y coordinate, so panning to a series game from
 * search or the sidebar centred the viewport ~76px above the Card.
 */

/** Games of a series in play order. Cards with no seriesIndex sort last. */
export const sortedSeriesDrafts = (groupDrafts: CanvasDraft[]): CanvasDraft[] =>
    [...groupDrafts].sort((a, b) => {
        const aIndex = a.Draft.seriesIndex;
        const bIndex = b.Draft.seriesIndex;
        if (aIndex === null || aIndex === undefined) {
            return bIndex === null || bIndex === undefined ? 0 : 1;
        }
        if (bIndex === null || bIndex === undefined) return -1;
        return aIndex - bIndex;
    });

export const getDraftWorldPosition = (
    draft: CanvasDraft,
    group: CanvasGroup | null | undefined,
    groupDrafts: CanvasDraft[],
    cardLayout: CardLayout
): { x: number; y: number } => {
    if (group && group.type === "series") {
        const index = Math.max(
            0,
            sortedSeriesDrafts(groupDrafts).findIndex(
                (cd) => cd.Draft.id === draft.Draft.id
            )
        );
        return getSeriesDraftWorldPosition(group, index, cardLayout);
    }
    if (group) {
        return {
            x: group.positionX + draft.positionX,
            y: group.positionY + draft.positionY
        };
    }
    return { x: draft.positionX, y: draft.positionY };
};
