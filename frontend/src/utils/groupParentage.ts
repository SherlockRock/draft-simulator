import { MAX_GROUP_DEPTH } from "@draft-sim/shared-types/canvas-tree-vector";
import { depthOf, subtreeHeight, wouldCreateCycle, type CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

/**
 * The client half of the parentage predicate (design §8.1).
 *
 * The server remains the enforcement — this exists so a drop does not silently
 * snap back looking like a bug, and because a **local canvas has no server at
 * all**: without it an anonymous user can put a cycle in localStorage, which
 * every walk in `canvasTree.ts` tolerates but nothing else should have to.
 *
 * The strings are the server's, VERBATIM (`resolveParentage` in
 * `backend/routes/canvas.js`), so the client cannot invent its own vocabulary
 * for a rejection the server will phrase differently.
 */
export const PARENTAGE_REJECTIONS = {
    notOnCanvas: "That group isn't on this canvas",
    intoSeries: "Can't put a group inside a series",
    intoSelf: "Can't put a group inside itself",
    tooDeep: "Too deeply nested"
} as const;

const stub = (id: string, parentId: string | null): CanvasGroup => ({
    id,
    canvas_id: "",
    name: "",
    type: "custom",
    positionX: 0,
    positionY: 0,
    parent_group_id: parentId,
    metadata: {}
});

/**
 * Why this parentage write would be rejected, or `null` when it is legal.
 *
 * Checked against the tree the write would PRODUCE, in the server's order:
 * existence, then series-leaf, then cycle, then depth. Depth is only meaningful
 * once the result is known to be acyclic, which is why it comes last.
 *
 * A `nodeId` that is not in `tree` is a Group that does not exist yet (the
 * create path): it is spliced in, because `depthOf` cannot measure a node that
 * is not there. The depth term uses `subtreeHeight` as well, since moving a
 * two-level subtree under a depth-3 parent puts its leaves at depth 5.
 */
export const parentageRejection = (
    tree: CanvasTree,
    nodeId: string,
    parentId: string | null
): string | null => {
    if (parentId !== null) {
        const parent = tree.groups.find((g) => g.id === parentId);
        if (!parent) return PARENTAGE_REJECTIONS.notOnCanvas;
        if (parent.type === "series") return PARENTAGE_REJECTIONS.intoSeries;
    }

    const exists = tree.groups.some((g) => g.id === nodeId);
    const next: CanvasTree = {
        drafts: tree.drafts,
        annotations: tree.annotations,
        groups: exists
            ? tree.groups.map((g) =>
                  g.id === nodeId ? { ...g, parent_group_id: parentId } : g
              )
            : [...tree.groups, stub(nodeId, parentId)]
    };

    if (wouldCreateCycle(next, nodeId, parentId)) return PARENTAGE_REJECTIONS.intoSelf;
    if (depthOf(next, nodeId) + subtreeHeight(next, nodeId) > MAX_GROUP_DEPTH) {
        return PARENTAGE_REJECTIONS.tooDeep;
    }
    return null;
};
