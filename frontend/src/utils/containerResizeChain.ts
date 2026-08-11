import { ancestorsOf, groupById, type CanvasTree } from "./canvasTree";

/**
 * Containers whose size may have changed because `groupId`'s contents did:
 * the group itself, then every ancestor, nearest first.
 *
 * §6.2 gap 1. `resyncGroupSize` only ever recomputed the one container it was
 * given, which was survivable while a child's height reached its parent through
 * `spanFor`'s ceil — anything under a whole cell was absorbed. §6.0a rule 2
 * makes a parent's row height a CONTINUOUS function of its children's heights,
 * so a nested container gaining 12px must now reach the root, and the gap goes
 * from rarely-visible to visible on almost every nested edit. That is why this
 * was out of scope and auto-rows brought it in.
 *
 * Nearest-first is not cosmetic: a child's new size is what its parent's row
 * height is measured from, so the innermost container has to settle before the
 * one containing it is measured.
 *
 * Cycle and orphan tolerance come free from `ancestorsOf`, which carries the
 * visited set and stops at a dangling parent — the optimistic-delete case,
 * where a child still points at a Group already removed from the store.
 */
export const resizeChainOf = (tree: CanvasTree, groupId: string): string[] => {
    if (!groupById(tree, groupId)) return [];
    return [groupId, ...ancestorsOf(tree, groupId).map((g) => g.id)];
};

/**
 * The containers a GROUP drag has to re-fit: the one it left and the one it
 * landed in, deduped, source first.
 *
 * `commitGroupDrag` used to resync `nextParentId` and only when parentage
 * CHANGED into it, which left two holes the Card path never had. A same-parent
 * reposition changes no parentage, so a series moved further up inside its free
 * parent never shrank it — the reported defect. And a Group dragged out to top
 * level has a null `nextParentId`, so the parent it abandoned was never
 * refitted either.
 *
 * §9.1a's locked rule ("never grow to chase a child that is leaving") survives
 * intact, because it is a rule about WHEN, not about which container: every
 * call here runs after the drag has committed, by which point a departed child
 * is no longer a member and cannot be chased. Mid-drag growth — the ratchet
 * that made drag-out unusable — is still nobody's job.
 *
 * Source first so a container losing a member settles before the one gaining
 * it is measured, which matters when one is nested inside the other and their
 * resize chains overlap.
 */
export const groupDragResyncTargets = (input: {
    previousParentId: string | null;
    nextParentId: string | null;
    rejected: boolean;
}): string[] => {
    // A rejected drop commits the position only, so parentage is unchanged and
    // `nextParentId` names a container the Group never joined. Refitting it
    // would size a container for a member it does not have.
    const next = input.rejected ? input.previousParentId : input.nextParentId;
    const targets: string[] = [];
    for (const id of [input.previousParentId, next]) {
        if (id && !targets.includes(id)) targets.push(id);
    }
    return targets;
};
