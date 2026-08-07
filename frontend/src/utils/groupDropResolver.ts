import type { CanvasGroup } from "./schemas";
import type { CanvasTree } from "./canvasTree";
import { findDropContainer } from "./canvasHitTest";
import { parentageRejection } from "./groupParentage";

export type GroupDropResolution =
    | { nextParentId: string | null; rejection?: undefined }
    | { rejection: string; nextParentId?: undefined };

/**
 * Where a dragged Group would land: which container it would join, `null` for
 * top level, or the reason it would be refused.
 *
 * **The point is the dragged Group's TOP-LEFT CORNER** (§9.1b, settled in
 * review round 1). The Card path uses two different points — the card centre
 * for containment, the container-relative top-left for cell derivation — and
 * for a Bo5 series ~3.6k world px wide the cursor, the centre and the top-left
 * name three different containers. The centre of a 3.6k-wide series is nowhere
 * near the pointer, and a user aiming a frame aims its corner. The hover
 * preview and the drop commit call this same function with the same point, or
 * the highlight promises a landing the drop does not deliver.
 *
 * The server remains the enforcement; this exists so a rejected drop does not
 * silently snap back looking like a bug (§8.1), and because a local canvas has
 * no server. The rejection strings come from `groupParentage`, which takes them
 * verbatim from the route.
 */
export const resolveGroupDrop = (
    tree: CanvasTree,
    args: { groupId: string; point: { x: number; y: number } }
): GroupDropResolution => {
    const container: CanvasGroup | null = findDropContainer(tree, args.point, {
        excludeSubtreeOf: args.groupId
    });
    const nextParentId = container?.id ?? null;
    // No-op drops are always legal, including for a Group already sitting
    // somewhere the predicate would now refuse — dragging a Group around inside
    // its own parent must not start failing because the tree grew deeper
    // elsewhere.
    const currentParentId =
        tree.groups.find((g) => g.id === args.groupId)?.parent_group_id ?? null;
    if (nextParentId === currentParentId) return { nextParentId };

    const rejection = parentageRejection(tree, args.groupId, nextParentId);
    return rejection ? { rejection } : { nextParentId };
};
