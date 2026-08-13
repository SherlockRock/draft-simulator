import type { CanvasAnnotation, CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";
import {
    GROUP_BORDER_WIDTH,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_Y,
    cardHeight,
    cardWidth,
    getSeriesGroupDimensions
} from "./helpers";
import {
    DEFAULT_GROUP_HEIGHT,
    DEFAULT_GROUP_WIDTH,
    GRID_CELL_GAP,
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    colAt,
    isGridGroup,
    rowsOfItems,
    type GridFootprint,
    type GridItem
} from "./gridLayout";
import { rowAtY } from "./gridRows";
import { sortedSeriesDrafts } from "./canvasWorldPosition";

/**
 * The canonical child / tree layer for the canvas.
 *
 * A Canvas holds three kinds of node with two different parent pointers — Groups
 * point at `parent_group_id`, while Cards and annotations point at `group_id` —
 * and nothing else in the app should have to know that. Every child query,
 * ancestry walk and render order lives here (recursive-groups design §7,
 * decision 2).
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
 * depth, while Card and annotation coordinates are relative to their immediate
 * container. That is why `gridItemsOf` subtracts the parent's position only for
 * a child Group.
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
    /** Required so construction sites cannot silently omit this node kind. */
    annotations: readonly CanvasAnnotation[];
};

/**
 * A node's id is its PLACEMENT identity: a Group or annotation's `id`, and for
 * a Card its `draft_id` — the id the store reconciles on. `Draft.id` holds the
 * same value today but means the Draft, not its placement on this canvas.
 */
export type TreeNode =
    | { kind: "group"; id: string; group: CanvasGroup }
    | { kind: "card"; id: string; card: CanvasDraft }
    | { kind: "annotation"; id: string; annotation: CanvasAnnotation };

/**
 * Both shapes are declared in `gridLayout.ts` — the layout engine owns the item
 * contract, this module owns how a node becomes one. Re-exported here because
 * `gridItemsOf` is where they come from in practice, and because the dependency
 * only runs one way (this module imports gridLayout, never the reverse).
 */
export type { GridFootprint, GridItem };

/**
 * Fallback size for a Group with no stored width/height. Declared in
 * `gridLayout.ts` (which also uses them as the sizing baseline for a container
 * the user has never resized) and re-exported here, where every consumer
 * already looks for them — the dependency runs one way, as with `GridItem`.
 */
export { DEFAULT_GROUP_WIDTH, DEFAULT_GROUP_HEIGHT };

export const groupById = (tree: CanvasTree, id: string): CanvasGroup | undefined =>
    tree.groups.find((g) => g.id === id);

const cardById = (tree: CanvasTree, id: string): CanvasDraft | undefined =>
    tree.drafts.find((d) => d.draft_id === id);

const annotationById = (tree: CanvasTree, id: string): CanvasAnnotation | undefined =>
    tree.annotations.find((annotation) => annotation.id === id);

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

const annotationNode = (annotation: CanvasAnnotation): TreeNode => ({
    kind: "annotation",
    id: annotation.id,
    annotation
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
    const annotation = annotationById(tree, nodeId);
    if (annotation) return annotation.group_id ?? null;
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

/** Direct annotation members of `groupId` (`null` = loose on the canvas). */
export const childAnnotationsOf = (
    tree: CanvasTree,
    groupId: string | null
): CanvasAnnotation[] =>
    tree.annotations.filter((annotation) => (annotation.group_id ?? null) === groupId);

/** Groups, then Cards, then annotations; each in its own query's order. */
export const childrenOf = (tree: CanvasTree, parentId: string | null): TreeNode[] => [
    ...childGroupsOf(tree, parentId).map(groupNode),
    ...childCardsOf(tree, parentId).map(cardNode),
    ...childAnnotationsOf(tree, parentId).map(annotationNode)
];

/**
 * Containers enclosing `nodeId`, nearest first. Works for leaf ids too.
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
 * The deepest node in `groupId`'s subtree, measured in levels BELOW it. 0 when
 * the Group has no child Groups.
 *
 * The depth cap has to be checked against `depthOf(next) + subtreeHeight`, not
 * against the moved Group alone: dropping a two-level subtree under a depth-3
 * parent puts its leaves at depth 5. Design §8.1 says "reject if the move would
 * exceed the cap" without saying which node's depth that is.
 *
 * Twin of `subtreeHeight` in `backend/services/canvasTree.js`.
 */
export const subtreeHeight = (tree: CanvasTree, groupId: string): number => {
    let height = 0;
    const visited = new Set<string>([groupId]);
    const walk = (parentId: string, level: number) => {
        if (level > height) height = level;
        for (const child of childGroupsOf(tree, parentId)) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            walk(child.id, level + 1);
        }
    };
    walk(groupId, 0);
    return height;
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
    const out: CanvasGroup[] = [];
    const visited = new Set<string>();

    const walk = (group: CanvasGroup) => {
        if (visited.has(group.id)) return;
        visited.add(group.id);
        out.push(group);
        for (const child of childGroupsOf(tree, group.id)) walk(child);
    };

    for (const root of rootGroupsOf(tree)) walk(root);

    return out;
};

/**
 * The Groups a top-down walk must START from — what `childGroupsOf(tree, null)`
 * is NOT.
 *
 * Any consumer that renders the tree from the top needs this rather than the
 * top-level query, because two of the three kinds of root are invisible to it:
 *
 *  - **Top-level Groups**, `parent_group_id == null`.
 *  - **Orphans**, whose parent names a row that is not in the tree. Filtering on
 *    `parent_group_id == null` makes a whole subtree vanish for a full round
 *    trip every time the optimistic delete runs.
 *  - **Cycle members**, which no root reaches. The server rejects cycles, but a
 *    local canvas has no server, and a node that silently disappears is worse
 *    than one drawn in an odd place.
 *
 * Roots and orphans come first in fetch order, then whatever a walk from those
 * never reached. Callers that RECURSE must still carry their own visited set:
 * this makes a cycle reachable, it does not make it finite.
 */
export const rootGroupsOf = (tree: CanvasTree): CanvasGroup[] => {
    const known = new Set(tree.groups.map((g) => g.id));
    const roots = tree.groups.filter((g) => {
        const parentId = g.parent_group_id ?? null;
        return parentId === null || !known.has(parentId);
    });

    const reached = new Set<string>();
    const walk = (group: CanvasGroup) => {
        if (reached.has(group.id)) return;
        reached.add(group.id);
        for (const child of childGroupsOf(tree, group.id)) walk(child);
    };
    for (const root of roots) walk(root);

    return [...roots, ...tree.groups.filter((g) => !reached.has(g.id))];
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
    if (node.kind === "annotation") {
        return { width: node.annotation.width, height: node.annotation.height };
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
 * A node's CONTENT INSET: its own top edge to where its first draft Card
 * begins, in the container-relative frame `gridItemsOf` reports positions in
 * (design §6.0a rule 3).
 *
 * This is what baseline alignment aligns on. A row's baseline is the largest
 * inset among its members, and each member sits at
 * `rowOffset + (baseline - its own inset)` — so a series' first game lands
 * level with a loose Card beside it instead of ~171px below it.
 *
 * Every value carries `GROUP_BORDER_WIDTH` once, for two different reasons
 * that happen to have the same size: a Card is positioned inside its parent
 * container's padding box, and a Group's own content sits inside its own
 * border. Uniform, therefore cancelling — see the test. The series' controls
 * term is NOT uniform and does not cancel, which is why §6.0a's flat inset
 * table was wrong and why Task 0 had to land first.
 *
 * A free container claims only its header: its content starts wherever the
 * user left it, so there is nothing else that can honestly be claimed.
 */
export const insetOf = (
    _tree: CanvasTree,
    node: TreeNode,
    _layout: CardLayout
): number => {
    // `_tree` and `_layout` are unused today and are in the signature
    // deliberately: it mirrors `nodeSize` and `footprintOf`, every call site
    // already has the triple, and a card-layout-dependent inset is one CSS
    // change away. A test pins that no inset varies by layout right now.
    if (node.kind === "card" || node.kind === "annotation") {
        return GROUP_BORDER_WIDTH;
    }
    if (node.group.type === "series") {
        return (
            GROUP_BORDER_WIDTH +
            SERIES_HEADER_HEIGHT +
            SERIES_PADDING_Y +
            SERIES_GAME_CONTROLS_HEIGHT
        );
    }
    if (isGridGroup(node.group)) {
        return GROUP_BORDER_WIDTH + GRID_HEADER_HEIGHT + GRID_PADDING;
    }
    return GROUP_BORDER_WIDTH + GRID_HEADER_HEIGHT;
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
 * The COLUMN span a node occupies inside a grid Group (design §6, §6.0a rule 1).
 *
 * One rule for all three kinds, no series special case. A Card is 1 because a
 * cell IS a card. Since 5a-6 a Bo-N series is exactly N columns:
 * `SERIES_PADDING_X` is 0 and `SERIES_CARD_GAP` equals `GRID_CELL_GAP`, so its
 * games land on the grid's own column rhythm.
 *
 * There is no row axis. §6.0a made rows auto-size to their tallest member, so a
 * series is one row tall however much chrome it carries — the row grows instead.
 * Its HEIGHT still matters, but to `gridRows.rowsOf` via `gridItemsOf`, not here.
 */
export const footprintOf = (
    tree: CanvasTree,
    node: TreeNode,
    layout: CardLayout
): GridFootprint => ({
    cols: spanFor(nodeSize(tree, node, layout).width, cardWidth(layout), GRID_CELL_GAP)
});

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
 * `position` is CONTAINER-relative for every kind, which costs a subtraction
 * for Groups and nothing for Cards or annotations: under ADR-0006 a Group
 * stores absolute world coordinates at every depth, while leaves store their
 * offset inside the container. Returns nothing for a Group not in the tree.
 *
 * **The row index is a COLLECTIVE property and cannot be computed per item**
 * (§6.0a). A member's `y` alone no longer says which row it is in — rule 3
 * deliberately gives row-mates different `y` — so the rows are derived once,
 * from the whole membership, and each item is then told which one it landed in.
 * `col` stays a per-item division, because the x axis is untouched.
 *
 * `inFlightIds` are members whose stored position is being rewritten every
 * mousemove. They are EXCLUDED from the row derivation and then attached to the
 * row their current y targets. Without that, a dragged node sitting at an
 * arbitrary y forms a row bucket of its own; if it hovers above the first real
 * row, every OTHER member's `cell.row` shifts by one, while the targeting rows
 * (`rowsOfItems(others)`) still index from 0. The two memberships then disagree,
 * `resolveGridDrop` finds no collision where there is one, and no swap or
 * relocation happens. `canvasObjectMoved` reproduces it on every observer.
 */
export const gridItemsOf = (
    tree: CanvasTree,
    groupId: string,
    layout: CardLayout,
    cols: number,
    inFlightIds: ReadonlySet<string> = new Set()
): GridItem[] => {
    const parent = groupById(tree, groupId);
    if (!parent) return [];
    const items = childrenOf(tree, groupId).map((node) => {
        const position =
            node.kind === "group"
                ? {
                      x: node.group.positionX - parent.positionX,
                      y: node.group.positionY - parent.positionY
                  }
                : node.kind === "card"
                  ? { x: node.card.positionX, y: node.card.positionY }
                  : { x: node.annotation.positionX, y: node.annotation.positionY };
        return {
            id: node.id,
            kind: node.kind,
            footprint: footprintOf(tree, node, layout),
            position,
            // Replaced below from the row model — a placeholder, never read.
            cell: { row: 0, col: colAt(position.x, layout, cols) },
            inset: insetOf(tree, node, layout),
            height: nodeSize(tree, node, layout).height
        };
    });

    // Rows come from the SETTLED members only.
    const rows = rowsOfItems(
        items.filter((i) => !inFlightIds.has(i.id)),
        layout
    );
    const rowIndexOf = new Map<string, number>();
    for (const row of rows) {
        // `row.index` — the ABSOLUTE lattice row. Using the array ordinal here
        // collapses every empty row and silently puts `GridItem.cell.row` in a
        // different coordinate system from `cellAt`/`rowAtY`, which return
        // lattice rows. The two are then compared in `resolveGridDrop`'s
        // collision set, `arrangeGrid`'s `ideal` and `reflowAfterGrowth`.
        for (const id of row.ids) rowIndexOf.set(id, row.index);
    }
    return items.map((item) => ({
        ...item,
        cell: {
            // An in-flight node has no settled row, so it is attached to the
            // row its CURRENT y targets — against the settled membership, so it
            // cannot perturb anyone else's index.
            row: rowIndexOf.get(item.id) ?? rowAtY(rows, item.position.y, layout),
            col: item.cell.col
        }
    }));
};
