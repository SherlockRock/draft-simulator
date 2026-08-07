import { descendantGroupsOf, type CanvasTree } from "./canvasTree";

/** One row of a Group position write, absolute world (ADR-0006). */
export type GroupPositionWrite = {
    id: string;
    positionX: number;
    positionY: number;
};

/**
 * Moving a Group means moving its whole subtree, and this is the ONLY place
 * that knows it.
 *
 * The rule is not "the drag's": **every** Group position write in the store
 * goes through here. A grid drop snaps a Group by a further delta (drop point →
 * cell origin, up to a whole cell) and a reflow relocates siblings; neither is a
 * drag, and neither would pass through a drag-shaped funnel. Server-side the
 * fan-out is automatic, so the symptom of skipping it is local-only — the
 * nested subtree visibly lags its parent until the broadcast lands.
 *
 * Each row is offset from **its own** stored value, never recomputed from the
 * dragged Group's origin. That is what lets a concurrent remote move of a
 * descendant survive the next frame, and it agrees with what the server
 * computes at commit (`stored + dx`).
 *
 * Returns nothing for a zero delta — a reparent writes no coordinates.
 */
export const subtreeMoveWrites = (
    tree: CanvasTree,
    groupId: string,
    dx: number,
    dy: number
): GroupPositionWrite[] => {
    if (dx === 0 && dy === 0) return [];
    return subtreeRows(tree, groupId).map((row) => ({
        id: row.id,
        positionX: row.positionX + dx,
        positionY: row.positionY + dy
    }));
};

/**
 * The subtree exactly as it stands — the dragged Group plus its descendants, at
 * their current absolute positions.
 *
 * The **local** commit needs this and the server commit does not. A local
 * canvas has nothing to fan a delta out for it, and the live drag writes only
 * the in-memory store, so without every row the descendants are lost on reload.
 * The server commit stays one entry: it derives `dx` from the locked row.
 */
export const subtreeRows = (tree: CanvasTree, groupId: string): GroupPositionWrite[] => {
    const moved = tree.groups.find((g) => g.id === groupId);
    if (!moved) return [];
    return [moved, ...descendantGroupsOf(tree, groupId)].map((group) => ({
        id: group.id,
        positionX: group.positionX,
        positionY: group.positionY
    }));
};
