import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { MAX_GROUP_DEPTH } from "@draft-sim/shared-types/canvas-tree-vector";

const require = createRequire(import.meta.url);
const { planCanvasGroupImport } = require("../../services/canvasGroupImport");

const group = (id, overrides = {}) => ({
  id,
  name: id,
  type: "custom",
  positionX: 0,
  positionY: 0,
  parent_group_id: null,
  width: null,
  height: null,
  metadata: {},
  ...overrides,
});

const card = (id, overrides = {}) => ({
  id,
  name: id,
  picks: [],
  positionX: 0,
  positionY: 0,
  group_id: null,
  ...overrides,
});

const planOf = (groups, drafts = []) =>
  planCanvasGroupImport({ name: "C", groups, drafts });

describe("planCanvasGroupImport — the tree", () => {
  it("keeps a parent id so the route's second pass can remap it", () => {
    const plan = planOf([group("top"), group("child", { parent_group_id: "top" })]);

    expect(plan.groups.map((g) => g.sourceId)).toEqual(["top", "child"]);
    expect(plan.groups[1].parentSourceId).toBe("top");
  });

  it("carries size and metadata through, and never rewrites a coordinate", () => {
    const plan = planOf([
      group("g", {
        positionX: 900,
        positionY: 700,
        width: 640,
        height: 480,
        parent_group_id: null,
        metadata: { layout: "grid", gridCols: 3 },
      }),
    ]);

    // ADR-0006: a Group's stored position is absolute at every depth, so
    // nesting is entirely `parent_group_id` — there is nothing to rebase.
    expect(plan.groups[0]).toMatchObject({
      positionX: 900,
      positionY: 700,
      width: 640,
      height: 480,
      metadata: { layout: "grid", gridCols: 3 },
    });
  });

  it("drops a `gameType` key left present-but-undefined by Zod's .catch", () => {
    const plan = planOf([group("g", { metadata: { layout: "grid", gameType: undefined } })]);

    expect(Object.prototype.hasOwnProperty.call(plan.groups[0].metadata, "gameType")).toBe(
      false,
    );
  });

  it("makes a Group top-level when its parent is not in the export", () => {
    const plan = planOf([group("child", { parent_group_id: "never-exported" })]);

    expect(plan.groups[0].parentSourceId).toBe(null);
  });

  it("breaks a hand-edited cycle at ONE edge instead of writing unrenderable rows", () => {
    const plan = planOf([
      group("a", { parent_group_id: "b" }),
      group("b", { parent_group_id: "a" }),
    ]);

    // Cutting one edge already makes the rest a legal tree, so the second
    // Group keeps its parent — the fixpoint stops as soon as every chain
    // reaches a root, rather than flattening the whole cycle.
    expect(plan.groups.map((g) => g.parentSourceId)).toEqual([null, "a"]);
    expect(plan.warnings.join(" ")).toMatch(/referenced/);
  });

  it("leaves a Group hanging below a cycle attached once the cycle is broken", () => {
    const plan = planOf([
      group("a", { parent_group_id: "b" }),
      group("b", { parent_group_id: "a" }),
      group("leaf", { parent_group_id: "b" }),
    ]);

    // Its chain was unmeasurable only while the cycle stood; the cut above it
    // gives it a root, so its own parentage survives.
    expect(plan.groups.find((g) => g.sourceId === "leaf").parentSourceId).toBe("b");
    expect(plan.groups.find((g) => g.sourceId === "a").parentSourceId).toBe(null);
  });

  it("flattens only the Group that breaches the depth cap", () => {
    const chain = [group("d0")];
    for (let depth = 1; depth <= MAX_GROUP_DEPTH + 1; depth += 1) {
      chain.push(group(`d${depth}`, { parent_group_id: `d${depth - 1}` }));
    }

    const plan = planOf(chain);
    const parentOf = new Map(plan.groups.map((g) => [g.sourceId, g.parentSourceId]));

    // The last legal ancestor count is MAX_GROUP_DEPTH, so `d{MAX}` keeps its
    // parent and only the one past it is cut loose.
    expect(parentOf.get(`d${MAX_GROUP_DEPTH}`)).toBe(`d${MAX_GROUP_DEPTH - 1}`);
    expect(parentOf.get(`d${MAX_GROUP_DEPTH + 1}`)).toBe(null);
    expect(plan.warnings.join(" ")).toMatch(new RegExp(`${MAX_GROUP_DEPTH} levels`));
  });
});

describe("planCanvasGroupImport — series containers", () => {
  it("does not rebuild a series container", () => {
    const plan = planOf([group("s", { type: "series" }), group("c")]);

    expect(plan.groups.map((g) => g.sourceId)).toEqual(["c"]);
    expect(plan.warnings.join(" ")).toMatch(/series container/);
  });

  it("makes a custom Group nested under a series container top-level", () => {
    const plan = planOf([
      group("s", { type: "series" }),
      group("c", { parent_group_id: "s" }),
    ]);

    expect(plan.groups[0].parentSourceId).toBe(null);
  });
});

describe("planCanvasGroupImport — Card placement", () => {
  it("leaves a loose Card exactly where the export put it", () => {
    const plan = planOf([], [card("d", { positionX: 12, positionY: 34 })]);

    expect(plan.cards[0]).toMatchObject({
      groupSourceId: null,
      positionX: 12,
      positionY: 34,
      rebased: false,
    });
  });

  it("keeps a Card's container-relative pair when its container is rebuilt", () => {
    const plan = planOf(
      [group("g", { positionX: 100, positionY: 200 })],
      [card("d", { group_id: "g", positionX: 30, positionY: 40 })],
    );

    // The container comes back at the SAME absolute position, so the stored
    // relative pair still means what it meant.
    expect(plan.cards[0]).toMatchObject({
      groupSourceId: "g",
      positionX: 30,
      positionY: 40,
      rebased: false,
    });
  });

  it("rebases a Card to world when its container is not rebuilt", () => {
    const plan = planOf(
      [group("s", { type: "series", positionX: 100, positionY: 200 })],
      [card("d", { group_id: "s", positionX: 30, positionY: 40 })],
    );

    // Same miss as localDeleteGroup's: container-relative numbers read as
    // world the moment the Card lands loose, so it jumps to near the origin.
    expect(plan.cards[0]).toMatchObject({
      groupSourceId: null,
      positionX: 130,
      positionY: 240,
      rebased: true,
    });
  });

  it("rebases against a container the export never carried, at the origin", () => {
    const plan = planOf([], [card("d", { group_id: "gone", positionX: 5, positionY: 6 })]);

    expect(plan.cards[0]).toMatchObject({ groupSourceId: null, positionX: 5, positionY: 6 });
  });

  it("does not rebase a Card whose container was only FLATTENED", () => {
    const plan = planOf(
      [
        group("outer", { positionX: 100, positionY: 100 }),
        group("inner", { parent_group_id: "outer", positionX: 300, positionY: 300 }),
      ],
      [card("d", { group_id: "inner", positionX: 10, positionY: 10 })],
    );

    // `inner` is rebuilt at its own absolute position either way, so its Cards
    // never move — only reparenting would be at stake, and it kept its parent.
    expect(plan.cards[0]).toMatchObject({
      groupSourceId: "inner",
      positionX: 10,
      positionY: 10,
    });
  });
});
