import type { GroupPositionUpdate } from "@draft-sim/shared-types";
import type { CanvasGroup } from "./schemas";
import type { GridPlacement, PositionUpdate } from "./gridLayout";
import { subtreeMoveWrites, type GroupPositionWrite } from "./groupSubtreeMove";
import type { CanvasTree } from "./canvasTree";

/**
 * The one place that turns the layout engine's answers into writes.
 *
 * `gridLayout.ts` is container-relative and kind-agnostic by contract, and it
 * stays that way: a `GridPlacement` says where a child sits inside its parent,
 * for a Card and a Group alike. But the two persist completely differently —
 * a Card's position IS container-relative and rides in `positions[]`, while a
 * Group's is absolute world at every depth (ADR-0006) and rides in `groups[]`.
 * Pushing the parent's world origin down into the engine to resolve that would
 * break the engine's whole contract, so the knowledge lives here instead, above
 * it, serving every caller (`commitGridDrop`, `arrangeGroupAsGrid`, and
 * whatever wires `reflowAfterGrowth`).
 *
 * Before this existed, `toPositionUpdates` simply **dropped** every Group
 * placement — total while nothing could put a Group in a grid, and silently
 * lossy the moment one could: "Arrange as grid" assigned a nested Group a cell,
 * threw the placement away, and sized the container from a layout that never
 * happened.
 */
export type GridWrites = {
    /** Card placements, container-relative, for `positions[]`. */
    positions: PositionUpdate[];
    /** Group placements, rebased to absolute world, for `groups[]`. */
    groups: GroupPositionUpdate[];
    /**
     * Optimistic store writes for the Group half — each moved Group **plus its
     * whole subtree**. The server fans the delta out itself, so this is not on
     * the wire; without it a nested subtree visibly lags its container until
     * the broadcast lands.
     */
    groupStoreWrites: GroupPositionWrite[];
};

export const splitGridPlacements = (args: {
    tree: CanvasTree;
    parent: CanvasGroup;
    placements: GridPlacement[];
}): GridWrites => {
    const { tree, parent, placements } = args;
    const positions: PositionUpdate[] = [];
    const groups: GroupPositionUpdate[] = [];
    const groupStoreWrites: GroupPositionWrite[] = [];

    for (const placement of placements) {
        if (placement.kind === "card") {
            positions.push({
                draft_id: placement.id,
                positionX: placement.positionX,
                positionY: placement.positionY
            });
            continue;
        }
        const positionX = parent.positionX + placement.positionX;
        const positionY = parent.positionY + placement.positionY;
        groups.push({ id: placement.id, positionX, positionY });

        const stored = tree.groups.find((g) => g.id === placement.id);
        if (stored) {
            groupStoreWrites.push(
                ...subtreeMoveWrites(
                    tree,
                    placement.id,
                    positionX - stored.positionX,
                    positionY - stored.positionY
                )
            );
        } else {
            // Entering the grid from outside and not in the store yet: there is
            // no subtree to carry, so the row itself is the whole write.
            groupStoreWrites.push({ id: placement.id, positionX, positionY });
        }
    }

    return { positions, groups, groupStoreWrites };
};
