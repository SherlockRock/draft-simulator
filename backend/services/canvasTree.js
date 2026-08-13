/**
 * Server-side Group tree walks — the sanctioned duplicate of
 * `frontend/src/utils/canvasTree.ts` (recursive-groups design §7, decision 2).
 *
 * It cannot be shared code: the frontend module is ESM, imports Solid-adjacent
 * layout helpers, and works on Zod-parsed wire shapes. What IS shared is the
 * test vector — `@draft-sim/shared-types/canvas-tree-vector` — which both
 * implementations consume verbatim, so "they agree" is a checked claim rather
 * than a convention.
 *
 * Two semantics a naive walk gets wrong, both pinned by the vector:
 *
 *  - **Orphans have depth 0.** A Group whose `parent_group_id` names a row that
 *    is not in the node list is a pseudo-root, not an error. The client's
 *    optimistic delete produces exactly this state, and the server can see it
 *    too whenever it validates against a partial fetch.
 *  - **A node inside a cycle has a bounded but ARBITRARY depth** — the walk
 *    stops at the first repeat. Depth is therefore never the cycle guard;
 *    `wouldCreateCycle` is. Every walk here carries a visited set, so a cycle
 *    already in the data can never hang a request.
 *
 * A `tree` is `{ groups, drafts, annotations }` of plain rows (Sequelize
 * instances work as they are): Groups carry `id` / `parent_group_id`, Cards
 * `draft_id` / `group_id`, and annotations `id` / `group_id`. Both leaf buckets
 * are optional — most server-side callers only have Groups.
 */

/**
 * Soft nesting cap (recursive-groups decision 6). Measured in ANCESTORS, so 4
 * permits five levels of containment. Checked against the deepest leaf of the
 * moved subtree, not the moved Group alone — dropping a two-level subtree under
 * a depth-3 parent puts its leaves at depth 5.
 *
 * Duplicated from `MAX_GROUP_DEPTH` in `@draft-sim/shared-types/canvas-tree-vector`,
 * which this file cannot require (ESM). `canvasGroupNesting.test.js` imports the
 * shared constant and derives its fixtures from it, so drift fails a test. It
 * lives here rather than in each route so the backend has ONE copy.
 */
const MAX_GROUP_DEPTH = 4;

const groupById = (tree, id) => tree.groups.find((g) => g.id === id);

const cardById = (tree, id) =>
  (tree.drafts ?? []).find((d) => d.draft_id === id);

const annotationById = (tree, id) =>
  (tree.annotations ?? []).find((annotation) => annotation.id === id);

/**
 * The container a node sits in: `null` at top level, `undefined` when the node
 * is not in the tree at all. A dangling `parent_group_id` comes back as the
 * dangling id — orphan detection is the caller's job, not this function's.
 */
function parentIdOf(tree, nodeId) {
  const group = groupById(tree, nodeId);
  if (group) return group.parent_group_id ?? null;
  const card = cardById(tree, nodeId);
  if (card) return card.group_id ?? null;
  const annotation = annotationById(tree, nodeId);
  if (annotation) return annotation.group_id ?? null;
  return undefined;
}

/** Child Groups of `parentId` (`null` = top level), in fetch order. */
function childGroupsOf(tree, parentId) {
  return tree.groups.filter((g) => (g.parent_group_id ?? null) === parentId);
}

/**
 * Containers enclosing `nodeId`, nearest first. Works for a Card id too.
 * Stops at a dangling parent and at a repeat, so it is always finite.
 */
function ancestorsOf(tree, nodeId) {
  const out = [];
  const seen = new Set([nodeId]);
  let parentId = parentIdOf(tree, nodeId);
  while (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
    const parent = groupById(tree, parentId);
    if (!parent) break;
    out.push(parent);
    seen.add(parentId);
    parentId = parent.parent_group_id ?? null;
  }
  return out;
}

/** Ancestor count: 0 for top level. What the soft depth cap measures. */
function depthOf(tree, nodeId) {
  return ancestorsOf(tree, nodeId).length;
}

/** Strictly inside `ancestorId`'s subtree. A node is NOT its own descendant. */
function isDescendant(tree, ancestorId, nodeId) {
  return ancestorsOf(tree, nodeId).some((g) => g.id === ancestorId);
}

/**
 * The guard for every reparent. One function rather than two checks per call
 * site because `isDescendant` alone silently permits the self-nest case.
 */
function wouldCreateCycle(tree, nodeId, nextParentId) {
  return (
    nextParentId !== null &&
    nextParentId !== undefined &&
    (nextParentId === nodeId || isDescendant(tree, nodeId, nextParentId))
  );
}

/**
 * Every Group below `groupId`, pre-order, excluding `groupId` itself.
 *
 * This is the set a container move fans its delta out over. `stopAt` prunes the
 * walk at any id it contains (the node and its whole subtree are skipped) —
 * used when a request moves a parent and one of its descendants in the same
 * commit, where the descendant's own absolute entry wins.
 */
function descendantGroupsOf(tree, groupId, stopAt) {
  const out = [];
  const visited = new Set([groupId]);
  const walk = (parentId) => {
    for (const child of childGroupsOf(tree, parentId)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (stopAt && stopAt.has(child.id)) continue;
      out.push(child);
      walk(child.id);
    }
  };
  walk(groupId);
  return out;
}

/**
 * Pre-order DFS over the Groups: parent, its whole subtree, next sibling's
 * subtree. **Not a depth sort.** Orphans are emitted as pseudo-roots and
 * cycle members are swept up at the end, so every Group comes out exactly once.
 *
 * The server has no renderer; this exists because the vector defines it and
 * because a deterministic subtree order is what recursive deletion (5b) needs.
 */
function renderOrder(tree) {
  const known = new Set(tree.groups.map((g) => g.id));
  const out = [];
  const visited = new Set();

  const walk = (group) => {
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
}

/**
 * The deepest node in `groupId`'s subtree, measured in levels BELOW it. 0 when
 * the Group has no child Groups.
 *
 * The depth cap has to be checked against this, not against the moved Group
 * alone: dropping a two-level subtree under a depth-3 parent puts its leaves at
 * depth 5. Design §8.1 says "reject if the move would exceed the cap" without
 * saying which node's depth that is.
 */
function subtreeHeight(tree, groupId) {
  let height = 0;
  const visited = new Set([groupId]);
  const walk = (parentId, level) => {
    if (level > height) height = level;
    for (const child of childGroupsOf(tree, parentId)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      walk(child.id, level + 1);
    }
  };
  walk(groupId, 0);
  return height;
}

module.exports = {
  MAX_GROUP_DEPTH,
  parentIdOf,
  childGroupsOf,
  ancestorsOf,
  depthOf,
  isDescendant,
  wouldCreateCycle,
  descendantGroupsOf,
  renderOrder,
  subtreeHeight,
};
