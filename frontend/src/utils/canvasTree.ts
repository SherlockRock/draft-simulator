import type { CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";
import { cardHeight, cardWidth, getSeriesGroupDimensions } from "./helpers";
import { GRID_CELL_GAP, positionToCell, type GridCell } from "./gridLayout";
import { sortedSeriesDrafts } from "./canvasWorldPosition";

/**
 * The canonical child / tree layer for the canvas.
 *
 * A Canvas holds two kinds of node with two different parent pointers — Groups
 * point at `parent_group_id`, Cards at `group_id` — and nothing else in the app
 * should have to know that. Every child query, ancestry walk and render order
 * lives here (recursive-groups design §7, decision 2).
 *
 * Three properties are load-bearing and each has a test:
 *
 *  - **Pre-order DFS render order, not a depth sort.** See `renderOrder`.
 *  - **Orphan tolerance.** The optimistic group delete removes a Group from the
 *    store while its children still point at it; those children must keep
 *    rendering, so an unreachable node is emitted as a pseudo-root.
 *  - **Cycle tolerance.** A cycle in the store must not be able to hang the
 *    renderer. The server rejects cycles, but local canvases have no server, so
 *    every walk here carries a visited set and terminates.
 *
 * Coordinates follow ADR-0006: a Group's positionX/Y are ABSOLUTE world at every
 * depth, a Card's are relative to its immediate container. That is why
 * `gridItemsOf` subtracts the parent's position for a child Group and not for a
 * child Card.
 *
 * **This is not the only implementation and cannot be** (design §7, rev 4). The
 * backend's validation (step 4) and the local-canvas mutation path each need
 * their own `depthOf` / `isDescendant`. Those are sanctioned duplicates governed
 * by a shared test vector — `@draft-sim/shared-types/canvas-tree-vector` — which
 * this module's tests consume and theirs must too.
 */

export type CanvasTree = {
    groups: readonly CanvasGroup[];
    drafts: readonly CanvasDraft[];
};

/**
 * A node's id is its PLACEMENT identity: a Group's `id`, and for a Card its
 * `draft_id` — the id the store reconciles on. `Draft.id` holds the same value
 * today but means the Draft, not its placement on this canvas.
 */
export type TreeNode =
    | { kind: "group"; id: string; group: CanvasGroup }
    | { kind: "card"; id: string; card: CanvasDraft };

export type GridFootprint = { rows: number; cols: number };

export type GridItem = {
    id: string;
    kind: TreeNode["kind"];
    footprint: GridFootprint;
    /** Top-left in CONTAINER-relative px — what `cell` was derived from. */
    position: { x: number; y: number };
    cell: GridCell;
};

/**
 * Fallback size for a Group with no stored width/height. These mirror
 * `groupWidth()`/`groupHeight()` in `CustomGroupContainer.tsx` and
 * `isPointInGroup` in `Canvas.tsx`; hit-testing is only correct while all three
 * agree (design §12).
 */
export const DEFAULT_GROUP_WIDTH = 400;
export const DEFAULT_GROUP_HEIGHT = 200;

const groupById = (tree: CanvasTree, id: string): CanvasGroup | undefined =>
    tree.groups.find((g) => g.id === id);

const cardById = (tree: CanvasTree, id: string): CanvasDraft | undefined =>
    tree.drafts.find((d) => d.draft_id === id);

const groupNode = (group: CanvasGroup): TreeNode => ({
    kind: "group",
    id: group.id,
    group
});

const cardNode = (card: CanvasDraft): TreeNode => ({
    kind: "card",
    id: card.draft_id,
    card
});

/**
 * The container a node sits in: `null` at top level, `undefined` when the node
 * is not in the tree at all.
 *
 * A Group whose `parent_group_id` names a row that is no longer in the store is
 * NOT top level — it is orphaned, and this returns the dangling id. The walks
 * below decide what to do about that; see `renderOrder`.
 */
export const parentIdOf = (
    tree: CanvasTree,
    nodeId: string
): string | null | undefined => {
    const group = groupById(tree, nodeId);
    if (group) return group.parent_group_id ?? null;
    const card = cardById(tree, nodeId);
    if (card) return card.group_id ?? null;
    return undefined;
};

/** Child Groups of `parentId` (`null` = top level), in store order. */
export const childGroupsOf = (tree: CanvasTree, parentId: string | null): CanvasGroup[] =>
    tree.groups.filter((g) => (g.parent_group_id ?? null) === parentId);

/**
 * Child Cards of `groupId` (`null` = loose on the canvas).
 *
 * A series' games come back in play order, because that is the order they
 * render in — `SeriesGroupContainer` lays them out with flexbox over the same
 * sort. The panel used to sort with `seriesIndex ?? 0`, which puts an
 * index-less Card FIRST while every other surface puts it last.
 */
export const childCardsOf = (tree: CanvasTree, groupId: string | null): CanvasDraft[] => {
    const cards = tree.drafts.filter((d) => (d.group_id ?? null) === groupId);
    const group = groupId === null ? undefined : groupById(tree, groupId);
    return group?.type === "series" ? sortedSeriesDrafts(cards) : cards;
};

/** Groups first, then Cards; each in the order the two queries above define. */
export const childrenOf = (tree: CanvasTree, parentId: string | null): TreeNode[] => [
    ...childGroupsOf(tree, parentId).map(groupNode),
    ...childCardsOf(tree, parentId).map(cardNode)
];

/**
 * Containers enclosing `nodeId`, nearest first. Works for a Card id too.
 *
 * Stops at a dangling parent (the orphan case) and at a repeat (the cycle
 * case), so the result is always finite and never contains a duplicate.
 */
export const ancestorsOf = (tree: CanvasTree, nodeId: string): CanvasGroup[] => {
    const out: CanvasGroup[] = [];
    const seen = new Set<string>([nodeId]);
    let parentId = parentIdOf(tree, nodeId);
    while (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
        const parent = groupById(tree, parentId);
        if (!parent) break;
        out.push(parent);
        seen.add(parentId);
        parentId = parent.parent_group_id ?? null;
    }
    return out;
};

/**
 * How deep `nodeId` sits: 0 for a top-level node, 1 for a child of a top-level
 * Group, and so on. This is what the soft depth cap (decision 6) measures.
 *
 * A node inside a cycle gets a bounded but arbitrary number — depth is not
 * meaningful there. The cycle guard is `wouldCreateCycle`, not a depth check.
 */
export const depthOf = (tree: CanvasTree, nodeId: string): number =>
    ancestorsOf(tree, nodeId).length;

/**
 * Is `nodeId` strictly inside `ancestorId`'s subtree? A node is NOT its own
 * descendant — use `wouldCreateCycle` for drop guards, which covers self-nest
 * as well.
 */
export const isDescendant = (
    tree: CanvasTree,
    ancestorId: string,
    nodeId: string
): boolean => ancestorsOf(tree, nodeId).some((g) => g.id === ancestorId);

/**
 * The guard for every reparent, on all three runtimes: dropping a node into
 * itself or into its own subtree would make the tree unwalkable.
 *
 * Exists as one function rather than two checks at each call site because
 * `isDescendant` alone silently permits the self-nest case.
 */
export const wouldCreateCycle = (
    tree: CanvasTree,
    nodeId: string,
    nextParentId: string | null
): boolean =>
    nextParentId !== null &&
    (nextParentId === nodeId || isDescendant(tree, nodeId, nextParentId));

/**
 * Every Group below `groupId`, pre-order, excluding `groupId` itself.
 *
 * This is the set a container drag has to move in the local store: the server
 * fans the delta out over descendants for everyone else, but the dragging
 * client only ever updates the Group it grabbed (design 3.1c).
 */
export const descendantGroupsOf = (tree: CanvasTree, groupId: string): CanvasGroup[] => {
    const out: CanvasGroup[] = [];
    const visited = new Set<string>([groupId]);
    const walk = (parentId: string) => {
        for (const child of childGroupsOf(tree, parentId)) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            out.push(child);
            walk(child.id);
        }
    };
    walk(groupId);
    return out;
};

/**
 * Paint order for the flat `<For each={canvasGroups}>` (decision 12): parent,
 * then its whole subtree, then the next sibling's subtree.
 *
 * **Pre-order DFS, NOT a depth sort.** A global depth sort paints every depth-1
 * node above every depth-0 node, so a child of container A floats above
 * unrelated container B and a dragged top-level container is pinned beneath
 * every nested Group on the canvas. Depth is a correct order only for
 * ancestor/descendant pairs; DFS is correct for both.
 *
 * Two store states that are not supposed to happen, but do:
 *
 *  - **Orphans.** `deleteGroupMutation.onMutate` drops a Group from the store
 *    immediately, leaving its children pointing at a row that is gone. Walking
 *    only from `parent_group_id == null` would blank that whole subtree for a
 *    full round trip, so a Group with a dangling parent is emitted as a
 *    pseudo-root.
 *  - **Cycles.** Unreachable from any root by construction; the final sweep
 *    emits them so nothing silently disappears, and the visited set means the
 *    walk terminates instead of hanging the renderer.
 *
 * Every Group in the store comes out exactly once.
 */
export const renderOrder = (tree: CanvasTree): CanvasGroup[] => {
    const known = new Set(tree.groups.map((g) => g.id));
    const out: CanvasGroup[] = [];
    const visited = new Set<string>();

    const walk = (group: CanvasGroup) => {
        if (visited.has(group.id)) return;
        visited.add(group.id);
        out.push(group);
        for (const child of childGroupsOf(tree, group.id)) walk(child);
    };

    for (const group of tree.groups) {
        const parentId = group.parent_group_id ?? null;
        if (parentId === null || !known.has(parentId)) walk(group);
    }
    // Anything still unvisited is in a cycle: no root reaches it.
    for (const group of tree.groups) walk(group);

    return out;
};

/**
 * The rect a node paints, in px.
 *
 * A series ignores its stored width/height — `SeriesGroupContainer` sizes
 * itself from its game count — while a custom Group is exactly its stored size.
 */
export const nodeSize = (
    tree: CanvasTree,
    node: TreeNode,
    layout: CardLayout
): { width: number; height: number } => {
    if (node.kind === "card") {
        return { width: cardWidth(layout), height: cardHeight(layout) };
    }
    if (node.group.type === "series") {
        return getSeriesGroupDimensions(childCardsOf(tree, node.group.id).length, layout);
    }
    return {
        width: node.group.width ?? DEFAULT_GROUP_WIDTH,
        height: node.group.height ?? DEFAULT_GROUP_HEIGHT
    };
};

/**
 * Lattice units a node of `size` px covers, where `n` units span
 * `n * cell + (n - 1) * gap`.
 *
 * The gaps sit INSIDE the span, which is why this is not `ceil(size / cell)`:
 * a node exactly `n * (cell + gap)` wide overhangs `n` units by one gap and
 * needs `n + 1`. Solving `n * cell + (n - 1) * gap >= size` gives
 * `ceil((size + gap) / (cell + gap))`.
 */
export const spanFor = (size: number, cell: number, gap: number): number => {
    if (!Number.isFinite(size) || !Number.isFinite(cell) || cell + gap <= 0) return 1;
    return Math.max(1, Math.ceil((size + gap) / (cell + gap)));
};

/**
 * The cell rectangle a node occupies inside a grid Group (design §6).
 *
 * One rule for all three kinds, no series special case. A Card is 1×1 because a
 * cell IS a card. A series is bigger than its game count suggests — series
 * chrome (header 56 / padding 20) and grid chrome (header 48 / padding 16 /
 * gap 24) disagree, so a Bo-N series is 40px wider than N cells and
 * `96 + cardHeight` tall: a Bo3 is 2×4 and a Bo5 is 2×6, in every card layout.
 * The `1×N` rule earlier revisions used was arithmetically wrong.
 */
export const footprintOf = (
    tree: CanvasTree,
    node: TreeNode,
    layout: CardLayout
): GridFootprint => {
    const size = nodeSize(tree, node, layout);
    return {
        cols: spanFor(size.width, cardWidth(layout), GRID_CELL_GAP),
        rows: spanFor(size.height, cardHeight(layout), GRID_CELL_GAP)
    };
};

/**
 * Widest child footprint, in columns — the "must fit" floor for a grid Group's
 * effective column count. 0 when the Group has no children.
 *
 * Kept free of the column count so it can be computed BEFORE it: the effective
 * width depends on this, and this depends only on sizes.
 */
export const maxChildSpanCols = (
    tree: CanvasTree,
    groupId: string,
    layout: CardLayout
): number =>
    childrenOf(tree, groupId).reduce(
        (widest, node) => Math.max(widest, footprintOf(tree, node, layout).cols),
        0
    );

/**
 * Children of a grid Group as footprint stamps for the layout engine.
 *
 * `position` is CONTAINER-relative for both kinds, which costs a subtraction
 * for Groups and nothing for Cards: under ADR-0006 a Group already stores
 * absolute world coordinates at every depth, a Card stores its offset inside
 * its container. Returns nothing for a Group that is not in the tree.
 */
export const gridItemsOf = (
    tree: CanvasTree,
    groupId: string,
    layout: CardLayout,
    cols: number
): GridItem[] => {
    const parent = groupById(tree, groupId);
    if (!parent) return [];
    return childrenOf(tree, groupId).map((node) => {
        const position =
            node.kind === "card"
                ? { x: node.card.positionX, y: node.card.positionY }
                : {
                      x: node.group.positionX - parent.positionX,
                      y: node.group.positionY - parent.positionY
                  };
        return {
            id: node.id,
            kind: node.kind,
            footprint: footprintOf(tree, node, layout),
            position,
            cell: positionToCell(position.x, position.y, layout, cols)
        };
    });
};
