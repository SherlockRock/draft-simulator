import type { CanvasGroup } from "./schemas";
import { DEFAULT_GROUP_HEIGHT, DEFAULT_GROUP_WIDTH } from "./gridLayout";
import { isDescendant, renderOrder, type CanvasTree } from "./canvasTree";

/**
 * Which container a point lands in, once containers can contain containers.
 *
 * Extracted from `Canvas.tsx` because 5a needs the answer in three places that
 * must agree — the card-drag hover preview, the card drop commit, and the
 * context menu — and `Canvas.tsx` has no component tests (plan A12).
 */

/**
 * Rect containment against the Group's stored size, with the same fallbacks
 * `CustomGroupContainer` paints with. Series are included; callers decide
 * whether a series is a legal target.
 */
export const isPointInGroup = (x: number, y: number, group: CanvasGroup): boolean => {
    const width = group.width ?? DEFAULT_GROUP_WIDTH;
    const height = group.height ?? DEFAULT_GROUP_HEIGHT;
    return (
        x >= group.positionX &&
        x <= group.positionX + width &&
        y >= group.positionY &&
        y <= group.positionY + height
    );
};

/**
 * The container a drop at `point` resolves to, or `null`.
 *
 * **The rule is PAINT ORDER, and depth never enters it** (3.1b, corrected in
 * review round 1). Candidates are `custom` Groups whose rect contains the
 * point; the answer is the one **last in `renderOrder`**.
 *
 * A depth-ranked version is wrong and reachably so: nothing clips (§6.2), so a
 * child can overhang its parent, and an unrelated root that comes later in
 * `renderOrder` paints *over* that overhanging child. Depth-descending would
 * then pick the child the user cannot see. Pre-order DFS always emits a child
 * after its parent, so "last painted" IS "deepest" for every ancestor/descendant
 * pair — and it resolves unrelated overlaps the way the screen does. That is
 * decision 12's own argument, which 3.1b failed to inherit.
 *
 * `excludeSubtreeOf` drops the dragged node and everything under it, so a
 * container can never be dropped into itself or into its own child.
 *
 * `paintOrder` lets a caller that already keeps `renderOrder` memoized pass it
 * in. This runs once or twice per mousemove during a card drag, and `renderOrder`
 * is O(groups²); the canvas has the exact same array as a memo that position
 * writes do not invalidate (plan A9), so recomputing it here would be the one
 * place that throws that property away.
 */
export const findDropContainer = (
    tree: CanvasTree,
    point: { x: number; y: number },
    opts?: { excludeSubtreeOf?: string; paintOrder?: readonly CanvasGroup[] }
): CanvasGroup | null => {
    const excluded = opts?.excludeSubtreeOf;
    let found: CanvasGroup | null = null;
    for (const group of opts?.paintOrder ?? renderOrder(tree)) {
        if (group.type !== "custom") continue;
        if (excluded !== undefined) {
            if (group.id === excluded) continue;
            if (isDescendant(tree, excluded, group.id)) continue;
        }
        if (isPointInGroup(point.x, point.y, group)) found = group;
    }
    return found;
};
