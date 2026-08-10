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
