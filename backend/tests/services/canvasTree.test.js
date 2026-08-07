import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { CANVAS_TREE_VECTOR } from "@draft-sim/shared-types/canvas-tree-vector";

const require = createRequire(import.meta.url);
const {
  ancestorsOf,
  childGroupsOf,
  depthOf,
  descendantGroupsOf,
  isDescendant,
  parentIdOf,
  renderOrder,
  subtreeHeight,
  wouldCreateCycle,
} = require("../../services/canvasTree");

// The vector's node shape is runtime-neutral on purpose; each implementation
// adapts it to its own rows. Here that means `parent_group_id` for Groups and
// `group_id` for Cards — the two different parent pointers decision 2 leaves in
// place, which is exactly what the shared vector exists to keep honest.
const fromVector = (nodes) => ({
  groups: nodes
    .filter((n) => n.kind === "group")
    .map((n) => ({ id: n.id, parent_group_id: n.parentId })),
  drafts: nodes
    .filter((n) => n.kind === "card")
    .map((n) => ({ draft_id: n.id, group_id: n.parentId })),
});

describe.each(CANVAS_TREE_VECTOR)("shared vector: $name", (vector) => {
  const t = fromVector(vector.nodes);

  it(vector.note, () => {
    expect(t.groups.length + t.drafts.length).toBe(vector.nodes.length);
  });

  it("agrees on depth", () => {
    for (const [id, expected] of Object.entries(vector.depth)) {
      expect(`${id}=${depthOf(t, id)}`).toBe(`${id}=${expected}`);
    }
  });

  it("agrees on descendant groups", () => {
    for (const [id, expected] of Object.entries(vector.descendantGroups)) {
      expect(descendantGroupsOf(t, id).map((g) => g.id)).toEqual(expected);
    }
  });

  it("agrees on isDescendant", () => {
    for (const c of vector.isDescendant) {
      expect(
        `${c.ancestor}>${c.node}=${isDescendant(t, c.ancestor, c.node)}`,
      ).toBe(`${c.ancestor}>${c.node}=${c.expected}`);
    }
  });

  it("agrees on the reparent cycle guard", () => {
    for (const c of vector.cycleGuard) {
      expect(
        `${c.node}->${c.target}=${wouldCreateCycle(t, c.node, c.target)}`,
      ).toBe(`${c.node}->${c.target}=${c.expected}`);
    }
  });

  it("agrees on render order", () => {
    expect(renderOrder(t).map((g) => g.id)).toEqual(vector.renderOrder);
  });
});

describe("orphans and cycles, stated as their own claims", () => {
  // Restating the two vector cases the walker is most likely to regress on,
  // because the vector asserts them as data and this asserts them as intent.
  it("treats a dangling parent as a pseudo-root, not an error", () => {
    const t = {
      groups: [
        { id: "g-child", parent_group_id: "g-gone" },
        { id: "g-grandchild", parent_group_id: "g-child" },
      ],
    };
    expect(depthOf(t, "g-child")).toBe(0);
    expect(depthOf(t, "g-grandchild")).toBe(1);
    expect(parentIdOf(t, "g-child")).toBe("g-gone");
    expect(ancestorsOf(t, "g-child")).toEqual([]);
  });

  it("terminates on a cycle instead of hanging", () => {
    const t = {
      groups: [
        { id: "a", parent_group_id: "b" },
        { id: "b", parent_group_id: "a" },
      ],
    };
    expect(depthOf(t, "a")).toBe(1);
    expect(descendantGroupsOf(t, "a").map((g) => g.id)).toEqual(["b"]);
    expect(wouldCreateCycle(t, "a", "b")).toBe(true);
  });

  it("returns undefined for a node that is not in the tree at all", () => {
    expect(parentIdOf({ groups: [] }, "nope")).toBeUndefined();
  });
});

describe("descendantGroupsOf pruning", () => {
  const t = {
    groups: [
      { id: "p", parent_group_id: null },
      { id: "c", parent_group_id: "p" },
      { id: "gc", parent_group_id: "c" },
      { id: "other", parent_group_id: "p" },
    ],
  };

  it("walks the whole subtree with no stop set", () => {
    expect(descendantGroupsOf(t, "p").map((g) => g.id)).toEqual([
      "c",
      "gc",
      "other",
    ]);
  });

  // A commit that moves both a parent and one of its descendants must not
  // apply two deltas to the descendant's own subtree.
  it("prunes a stopped node together with its subtree", () => {
    expect(descendantGroupsOf(t, "p", new Set(["c"])).map((g) => g.id)).toEqual(
      ["other"],
    );
  });
});

describe("subtreeHeight", () => {
  const t = {
    groups: [
      { id: "root", parent_group_id: null },
      { id: "a", parent_group_id: "root" },
      { id: "b", parent_group_id: "a" },
      { id: "flat", parent_group_id: null },
    ],
  };

  it("is 0 for a leaf and counts levels below otherwise", () => {
    expect(subtreeHeight(t, "flat")).toBe(0);
    expect(subtreeHeight(t, "b")).toBe(0);
    expect(subtreeHeight(t, "a")).toBe(1);
    expect(subtreeHeight(t, "root")).toBe(2);
  });

  it("terminates inside a cycle", () => {
    const cyc = {
      groups: [
        { id: "x", parent_group_id: "y" },
        { id: "y", parent_group_id: "x" },
      ],
    };
    expect(subtreeHeight(cyc, "x")).toBe(1);
  });
});

describe("childGroupsOf", () => {
  it("treats a missing parent_group_id as top level", () => {
    const t = { groups: [{ id: "g" }] };
    expect(childGroupsOf(t, null).map((g) => g.id)).toEqual(["g"]);
  });
});
