/**
 * Cross-runtime test vector for the canvas Group tree.
 *
 * The recursive-groups design (§7, rev 4) concedes that the tree walk cannot
 * have a single implementation: `frontend/src/utils/canvasTree.ts` covers the
 * canvas UI, `backend/routes/canvas.js` has to validate reparents server-side,
 * and the local-canvas path in `useLocalCanvasMutations.ts` has no server at
 * all. Three implementations that must agree, or the client's optimistic drop
 * and the server's validation disagree — and on a local canvas a cycle nobody
 * rejected becomes an infinite loop at render time.
 *
 * So they are sanctioned duplicates governed by this vector. Every
 * implementation is expected to consume it verbatim: no imports, plain data,
 * usable from ESM, CJS and a browser bundle alike.
 *
 * Consumers so far:
 *  - `frontend/src/utils/canvasTree.test.ts`
 *
 * The defined behaviours worth stating, because two of them are choices rather
 * than consequences:
 *
 *  - An **orphan** — a Group whose `parentId` names a row that is not in the
 *    node list, which is what the optimistic delete produces — counts as top
 *    level for `depth`, and is a pseudo-root in `renderOrder` so its subtree
 *    keeps rendering.
 *  - A node inside a **cycle** has a bounded but arbitrary `depth`; the walk
 *    stops at the first repeat. Depth is not the cycle guard, `cycleGuard` is.
 *  - `renderOrder` is pre-order DFS in node-list order (parent, its whole
 *    subtree, then the next sibling's subtree) — NOT a depth sort. Case
 *    `nested` distinguishes them: a depth sort yields
 *    `g-root, g-solo, g-a, g-b, g-a1`.
 */

/**
 * Soft nesting cap (design decision 6), measured in ANCESTORS — so 4 permits
 * five levels of containment. Checked against the deepest leaf of the moved
 * subtree, not the moved Group alone: dropping a two-level subtree under a
 * depth-3 parent puts its leaves at depth 5.
 *
 * Lives with the vector because it is the same kind of thing — a value three
 * runtimes must agree on. `backend/routes/canvas.js` keeps its own literal (it
 * is CommonJS and cannot require this ESM package); the backend route tests
 * import this constant and derive their fixtures from it, so a drift is a test
 * failure rather than a convention.
 */
export const MAX_GROUP_DEPTH = 4;

export type CanvasTreeVectorNode = {
  id: string;
  kind: "group" | "card";
  /** `parent_group_id` for a Group, `group_id` for a Card. `null` = top level. */
  parentId: string | null;
};

export type CanvasTreeVectorCase = {
  name: string;
  note: string;
  /** In store order — the order the walks iterate, and so the tie-break. */
  nodes: CanvasTreeVectorNode[];
  /** Expected ancestor count per node id, Cards included. */
  depth: Record<string, number>;
  /** Expected strict descendant GROUPS per group id, pre-order. */
  descendantGroups: Record<string, string[]>;
  /** Expected `isDescendant(ancestor, node)`; a node is not its own descendant. */
  isDescendant: { ancestor: string; node: string; expected: boolean }[];
  /** Expected reparent rejection: dropping `node` into `target`. */
  cycleGuard: { node: string; target: string | null; expected: boolean }[];
  /** Expected pre-order DFS over the Groups only. */
  renderOrder: string[];
};

export const CANVAS_TREE_VECTOR: CanvasTreeVectorCase[] = [
  {
    name: "nested",
    note: "A well-formed tree: two roots, a three-deep chain, and Cards at three levels.",
    nodes: [
      { id: "g-root", kind: "group", parentId: null },
      { id: "g-a", kind: "group", parentId: "g-root" },
      { id: "g-b", kind: "group", parentId: "g-root" },
      { id: "g-a1", kind: "group", parentId: "g-a" },
      { id: "g-solo", kind: "group", parentId: null },
      { id: "c-1", kind: "card", parentId: "g-a1" },
      { id: "c-2", kind: "card", parentId: null },
      { id: "c-3", kind: "card", parentId: "g-root" },
    ],
    depth: {
      "g-root": 0,
      "g-a": 1,
      "g-b": 1,
      "g-a1": 2,
      "g-solo": 0,
      "c-1": 3,
      "c-2": 0,
      "c-3": 1,
    },
    descendantGroups: {
      "g-root": ["g-a", "g-a1", "g-b"],
      "g-a": ["g-a1"],
      "g-a1": [],
      "g-b": [],
      "g-solo": [],
    },
    isDescendant: [
      { ancestor: "g-root", node: "g-a1", expected: true },
      { ancestor: "g-root", node: "c-1", expected: true },
      { ancestor: "g-a1", node: "c-1", expected: true },
      { ancestor: "g-a", node: "g-b", expected: false },
      { ancestor: "g-solo", node: "g-a", expected: false },
      { ancestor: "g-root", node: "g-root", expected: false },
      { ancestor: "g-root", node: "c-2", expected: false },
    ],
    cycleGuard: [
      { node: "g-root", target: "g-a1", expected: true },
      { node: "g-a", target: "g-a", expected: true },
      { node: "g-a", target: "g-b", expected: false },
      { node: "g-a", target: null, expected: false },
      { node: "g-solo", target: "g-a1", expected: false },
    ],
    renderOrder: ["g-root", "g-a", "g-a1", "g-b", "g-solo"],
  },
  {
    name: "orphan",
    note: "What the optimistic group delete leaves behind: children still point at a row that is gone.",
    nodes: [
      { id: "g-child", kind: "group", parentId: "g-deleted" },
      { id: "g-grandchild", kind: "group", parentId: "g-child" },
      { id: "g-top", kind: "group", parentId: null },
      { id: "c-x", kind: "card", parentId: "g-deleted" },
    ],
    depth: {
      "g-child": 0,
      "g-grandchild": 1,
      "g-top": 0,
      "c-x": 0,
    },
    descendantGroups: {
      "g-child": ["g-grandchild"],
      "g-grandchild": [],
      "g-top": [],
    },
    isDescendant: [
      { ancestor: "g-child", node: "g-grandchild", expected: true },
      { ancestor: "g-deleted", node: "g-child", expected: false },
      { ancestor: "g-deleted", node: "c-x", expected: false },
    ],
    cycleGuard: [
      { node: "g-child", target: "g-grandchild", expected: true },
      { node: "g-top", target: "g-child", expected: false },
    ],
    renderOrder: ["g-child", "g-grandchild", "g-top"],
  },
  {
    name: "cycle",
    note: "A two-cycle with a tail, plus an unrelated healthy subtree. Nothing here is reachable from a root except g-z.",
    nodes: [
      { id: "g-x", kind: "group", parentId: "g-y" },
      { id: "g-y", kind: "group", parentId: "g-x" },
      { id: "g-z", kind: "group", parentId: null },
      { id: "g-z1", kind: "group", parentId: "g-z" },
      { id: "g-t", kind: "group", parentId: "g-y" },
    ],
    depth: {
      "g-x": 1,
      "g-y": 1,
      "g-z": 0,
      "g-z1": 1,
      "g-t": 2,
    },
    descendantGroups: {
      "g-x": ["g-y", "g-t"],
      "g-y": ["g-x", "g-t"],
      "g-z": ["g-z1"],
      "g-t": [],
    },
    isDescendant: [
      { ancestor: "g-x", node: "g-y", expected: true },
      { ancestor: "g-y", node: "g-x", expected: true },
      { ancestor: "g-x", node: "g-t", expected: true },
      { ancestor: "g-z", node: "g-x", expected: false },
      { ancestor: "g-x", node: "g-z1", expected: false },
    ],
    cycleGuard: [
      { node: "g-x", target: "g-y", expected: true },
      { node: "g-x", target: "g-t", expected: true },
      { node: "g-z", target: "g-x", expected: false },
    ],
    renderOrder: ["g-z", "g-z1", "g-x", "g-y", "g-t"],
  },
];
