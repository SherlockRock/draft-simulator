import { describe, expect, it } from "vitest";
import {
    CANVAS_TREE_VECTOR,
    type CanvasTreeVectorNode
} from "@draft-sim/shared-types/canvas-tree-vector";
import {
    ancestorsOf,
    childCardsOf,
    childGroupsOf,
    childrenOf,
    depthOf,
    descendantGroupsOf,
    footprintOf,
    gridItemsOf,
    isDescendant,
    maxChildSpanCols,
    nodeSize,
    parentIdOf,
    renderOrder,
    spanFor,
    subtreeHeight,
    wouldCreateCycle,
    type CanvasTree
} from "./canvasTree";
import {
    GRID_CELL_GAP,
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    cellToPosition
} from "./gridLayout";
import { cardHeight, cardWidth, getSeriesGroupDimensions } from "./helpers";
import type { CanvasDraft, CanvasGroup } from "./schemas";
import type { CardLayout } from "./canvasCardLayout";

const LAYOUT: CardLayout = "wide";
const ALL_LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

const card = (
    id: string,
    opts: {
        group_id?: string | null;
        x?: number;
        y?: number;
        seriesIndex?: number | null;
    } = {}
): CanvasDraft => ({
    draft_id: id,
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    group_id: opts.group_id ?? null,
    source_type: "canvas",
    Draft: {
        id,
        name: id,
        picks: Array(20).fill(""),
        type: "canvas",
        ...(opts.seriesIndex === undefined ? {} : { seriesIndex: opts.seriesIndex })
    }
});

const group = (
    id: string,
    opts: {
        parent?: string | null;
        type?: "custom" | "series";
        x?: number;
        y?: number;
        width?: number;
        height?: number;
    } = {}
): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: opts.type ?? "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    width: opts.width,
    height: opts.height,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

const tree = (groups: CanvasGroup[], drafts: CanvasDraft[] = []): CanvasTree => ({
    groups,
    drafts
});

/** The vector is runtime-agnostic data; give it this runtime's shapes. */
const fromVector = (nodes: CanvasTreeVectorNode[]): CanvasTree =>
    tree(
        nodes
            .filter((n) => n.kind === "group")
            .map((n) => group(n.id, { parent: n.parentId })),
        nodes
            .filter((n) => n.kind === "card")
            .map((n) => card(n.id, { group_id: n.parentId }))
    );

describe("child queries", () => {
    it("splits a container's children by their two different parent pointers", () => {
        const t = tree(
            [group("g1"), group("g2", { parent: "g1" }), group("g3")],
            [card("c1", { group_id: "g1" }), card("c2", { group_id: "g3" })]
        );
        expect(childGroupsOf(t, "g1").map((g) => g.id)).toEqual(["g2"]);
        expect(childCardsOf(t, "g1").map((c) => c.draft_id)).toEqual(["c1"]);
        expect(childrenOf(t, "g1")).toEqual([
            { kind: "group", id: "g2", group: t.groups[1] },
            { kind: "card", id: "c1", card: t.drafts[0] }
        ]);
    });

    it("treats null as the top level for both kinds", () => {
        const t = tree(
            [group("g1"), group("g2", { parent: "g1" })],
            [card("c1"), card("c2", { group_id: "g1" })]
        );
        expect(childrenOf(t, null).map((n) => n.id)).toEqual(["g1", "c1"]);
    });

    it("identifies a Card by draft_id, not Draft.id", () => {
        const t = tree([group("g1")], [card("c1", { group_id: "g1" })]);
        expect(childrenOf(t, "g1")[0].id).toBe("c1");
        expect(parentIdOf(t, "c1")).toBe("g1");
    });

    it("returns a series' games in play order, index-less last", () => {
        const t = tree(
            [group("s1", { type: "series" })],
            [
                card("c-none", { group_id: "s1", seriesIndex: null }),
                card("c-2", { group_id: "s1", seriesIndex: 2 }),
                card("c-1", { group_id: "s1", seriesIndex: 1 })
            ]
        );
        expect(childCardsOf(t, "s1").map((c) => c.draft_id)).toEqual([
            "c-1",
            "c-2",
            "c-none"
        ]);
    });

    it("leaves a custom group's cards in store order", () => {
        const t = tree(
            [group("g1")],
            [
                card("c-b", { group_id: "g1", seriesIndex: 2 }),
                card("c-a", { group_id: "g1", seriesIndex: 1 })
            ]
        );
        expect(childCardsOf(t, "g1").map((c) => c.draft_id)).toEqual(["c-b", "c-a"]);
    });

    it("reports an unknown node as undefined rather than top level", () => {
        const t = tree([group("g1")]);
        expect(parentIdOf(t, "g1")).toBeNull();
        expect(parentIdOf(t, "nope")).toBeUndefined();
    });
});

describe("renderOrder", () => {
    it("is pre-order DFS, not a depth sort", () => {
        // Depth-sorted this is [root, solo, a, b, a1]: a1 (depth 2) would paint
        // above the unrelated container `solo`, and `solo` would be pinned
        // beneath every nested group on the canvas.
        const t = tree([
            group("root"),
            group("a", { parent: "root" }),
            group("b", { parent: "root" }),
            group("a1", { parent: "a" }),
            group("solo")
        ]);
        expect(renderOrder(t).map((g) => g.id)).toEqual(["root", "a", "a1", "b", "solo"]);
    });

    // The property that makes decision 12 cheap during a drag (plan A9): the
    // paint-order memo in Canvas.tsx reads only `id` and `parent_group_id`, so
    // Solid's per-property store tracking does NOT invalidate it on a position
    // write — including the per-frame subtree fan-out. Pinned here at the data
    // level so widening what renderOrder reads breaks a test rather than a
    // frame budget.
    it("is unchanged by a position-only edit", () => {
        const groups = [
            group("root", { x: 0, y: 0 }),
            group("a", { parent: "root", x: 10, y: 10 })
        ];
        const before = renderOrder(tree(groups)).map((g) => g.id);
        const moved = groups.map((g) => ({ ...g, positionX: g.positionX + 500 }));
        expect(renderOrder(tree(moved)).map((g) => g.id)).toEqual(before);
    });

    it("keeps a whole sibling subtree together", () => {
        const t = tree([
            group("root"),
            group("a", { parent: "root" }),
            group("a1", { parent: "a" }),
            group("a2", { parent: "a" }),
            group("b", { parent: "root" }),
            group("b1", { parent: "b" })
        ]);
        expect(renderOrder(t).map((g) => g.id)).toEqual([
            "root",
            "a",
            "a1",
            "a2",
            "b",
            "b1"
        ]);
    });

    it("emits an orphaned subtree as a pseudo-root", () => {
        // The optimistic delete of `gone` removes it from the store while its
        // children still point at it. Walking only from parent_group_id == null
        // would blank this whole subtree until the server replies.
        const t = tree([
            group("kept"),
            group("orphan", { parent: "gone" }),
            group("orphan-child", { parent: "orphan" })
        ]);
        expect(renderOrder(t).map((g) => g.id)).toEqual([
            "kept",
            "orphan",
            "orphan-child"
        ]);
    });

    it("terminates on a cycle and still emits every group once", () => {
        const t = tree([
            group("x", { parent: "y" }),
            group("y", { parent: "x" }),
            group("z"),
            group("tail", { parent: "y" })
        ]);
        const order = renderOrder(t).map((g) => g.id);
        expect(order).toEqual(["z", "x", "y", "tail"]);
        expect(new Set(order).size).toBe(order.length);
    });

    it("terminates on a self-parenting group", () => {
        const t = tree([group("self", { parent: "self" }), group("ok")]);
        expect(renderOrder(t).map((g) => g.id)).toEqual(["ok", "self"]);
    });

    it("returns every group in the store", () => {
        const t = tree([
            group("root"),
            group("a", { parent: "root" }),
            group("orphan", { parent: "gone" }),
            group("x", { parent: "y" }),
            group("y", { parent: "x" })
        ]);
        expect(renderOrder(t)).toHaveLength(t.groups.length);
    });
});

describe("ancestry", () => {
    it("walks containers nearest-first, Cards included", () => {
        const t = tree(
            [group("root"), group("mid", { parent: "root" })],
            [card("c1", { group_id: "mid" })]
        );
        expect(ancestorsOf(t, "c1").map((g) => g.id)).toEqual(["mid", "root"]);
        expect(depthOf(t, "c1")).toBe(2);
        expect(depthOf(t, "root")).toBe(0);
    });

    it("treats an orphan as top level", () => {
        const t = tree([group("orphan", { parent: "gone" })]);
        expect(ancestorsOf(t, "orphan")).toEqual([]);
        expect(depthOf(t, "orphan")).toBe(0);
    });

    it("stops at the first repeat inside a cycle", () => {
        const t = tree([
            group("x", { parent: "y" }),
            group("y", { parent: "x" }),
            group("tail", { parent: "y" })
        ]);
        expect(ancestorsOf(t, "tail").map((g) => g.id)).toEqual(["y", "x"]);
        expect(depthOf(t, "x")).toBe(1);
    });

    it("does not make a node its own descendant", () => {
        const t = tree([group("root"), group("a", { parent: "root" })]);
        expect(isDescendant(t, "root", "root")).toBe(false);
        expect(isDescendant(t, "root", "a")).toBe(true);
        expect(isDescendant(t, "a", "root")).toBe(false);
    });

    it("rejects a self-nest that isDescendant alone would allow", () => {
        const t = tree([group("root"), group("a", { parent: "root" })]);
        expect(isDescendant(t, "a", "a")).toBe(false);
        expect(wouldCreateCycle(t, "a", "a")).toBe(true);
        expect(wouldCreateCycle(t, "root", "a")).toBe(true);
        expect(wouldCreateCycle(t, "a", null)).toBe(false);
    });

    it("measures subtree height in levels below the node", () => {
        const t = tree([
            group("root"),
            group("a", { parent: "root" }),
            group("a1", { parent: "a" }),
            group("b", { parent: "root" }),
            group("flat")
        ]);
        expect(subtreeHeight(t, "root")).toBe(2);
        expect(subtreeHeight(t, "a")).toBe(1);
        expect(subtreeHeight(t, "a1")).toBe(0);
        expect(subtreeHeight(t, "flat")).toBe(0);
    });

    it("bounds subtree height inside a cycle instead of hanging", () => {
        const t = tree([group("x", { parent: "y" }), group("y", { parent: "x" })]);
        expect(subtreeHeight(t, "x")).toBe(1);
    });

    it("collects descendant groups pre-order, excluding self and Cards", () => {
        const t = tree(
            [
                group("root"),
                group("a", { parent: "root" }),
                group("a1", { parent: "a" }),
                group("b", { parent: "root" })
            ],
            [card("c1", { group_id: "a1" })]
        );
        expect(descendantGroupsOf(t, "root").map((g) => g.id)).toEqual(["a", "a1", "b"]);
        expect(descendantGroupsOf(t, "a1")).toEqual([]);
    });

    it("terminates when collecting descendants of a cycle member", () => {
        const t = tree([group("x", { parent: "y" }), group("y", { parent: "x" })]);
        expect(descendantGroupsOf(t, "x").map((g) => g.id)).toEqual(["y"]);
    });
});

// The backend (step 4) and the local-canvas guard are separate implementations
// of these same walks; they are expected to run this vector verbatim.
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
            expect(`${c.ancestor}>${c.node}=${isDescendant(t, c.ancestor, c.node)}`).toBe(
                `${c.ancestor}>${c.node}=${c.expected}`
            );
        }
    });

    it("agrees on the reparent cycle guard", () => {
        for (const c of vector.cycleGuard) {
            expect(
                `${c.node}->${c.target}=${wouldCreateCycle(t, c.node, c.target)}`
            ).toBe(`${c.node}->${c.target}=${c.expected}`);
        }
    });

    it("agrees on render order", () => {
        expect(renderOrder(t).map((g) => g.id)).toEqual(vector.renderOrder);
    });
});

describe("spanFor", () => {
    it("is one unit for something exactly a cell wide", () => {
        expect(spanFor(100, 100, 20)).toBe(1);
    });

    it("counts the gaps as inside the span", () => {
        // Two units span 100 + 20 + 100 = 220.
        expect(spanFor(220, 100, 20)).toBe(2);
        expect(spanFor(221, 100, 20)).toBe(3);
    });

    it("needs an extra unit for a node sized to n whole pitches", () => {
        // ceil(size / cell) would say 2 here, but 2 units only span 220 and this
        // node is 240 wide — it overhangs by exactly one gap.
        expect(spanFor(240, 100, 20)).toBe(3);
    });

    it("never returns less than one, and survives a NaN size", () => {
        expect(spanFor(0, 100, 20)).toBe(1);
        expect(spanFor(-50, 100, 20)).toBe(1);
        expect(spanFor(Number.NaN, 100, 20)).toBe(1);
    });
});

describe("footprints", () => {
    it("makes a Card exactly one cell", () => {
        const t = tree([group("g1")], [card("c1", { group_id: "g1" })]);
        expect(footprintOf(t, childrenOf(t, "g1")[0], LAYOUT)).toEqual({
            rows: 1,
            cols: 1
        });
    });

    it("sizes a series from its game count, not its stored size", () => {
        const t = tree(
            [group("s1", { type: "series", width: 10, height: 10 })],
            [
                card("c1", { group_id: "s1", seriesIndex: 1 }),
                card("c2", { group_id: "s1", seriesIndex: 2 })
            ]
        );
        expect(
            nodeSize(t, { kind: "group", id: "s1", group: t.groups[0] }, LAYOUT)
        ).toEqual(getSeriesGroupDimensions(2, LAYOUT));
    });

    // 5a-6 retired the 2x4 / 2x6 contract: with SERIES_PADDING_X at 0 a Bo-N
    // series is exactly N columns.
    //
    // COLUMNS ONLY, deliberately. §6.0a Task 0 grew a series' height by the
    // per-game control block, which moves its ROW span in some layouts — and
    // §6.0a rule 1 then deletes the row axis outright, because rows auto-size.
    // What must not move, and is asserted here for every layout and every
    // odd Bo-N, is the column span: that is what feeds `maxChildSpanCols` and
    // `effectiveGridCols`, and a change there would silently relay out every
    // grid holding a series.
    it.each(ALL_LAYOUTS)("makes a Bo-N series exactly N columns in %s", (layout) => {
        const seriesNode = (t: CanvasTree) => childrenOf(t, "root")[0];
        for (const n of [1, 3, 5, 7]) {
            const t = tree(
                [group("root"), group("s1", { type: "series", parent: "root" })],
                Array.from({ length: n }, (_, i) =>
                    card(`c${i}`, { group_id: "s1", seriesIndex: i + 1 })
                )
            );
            expect(footprintOf(t, seriesNode(t), layout).cols).toBe(n);
        }
    });

    it("stamps a footprint that actually contains the node it describes", () => {
        // The point of the rule: N columns span N*cw + (N-1)*gap, and the
        // series has to fit inside its own stamp or it spills into the
        // neighbour's cells.
        const t = tree(
            [group("root"), group("s1", { type: "series", parent: "root" })],
            Array.from({ length: 5 }, (_, i) =>
                card(`c${i}`, { group_id: "s1", seriesIndex: i + 1 })
            )
        );
        const node = childrenOf(t, "root")[0];
        const { cols, rows } = footprintOf(t, node, LAYOUT);
        const size = nodeSize(t, node, LAYOUT);
        const spanned = (n: number, cell: number) => n * cell + (n - 1) * GRID_CELL_GAP;
        expect(spanned(cols, cardWidth(LAYOUT))).toBeGreaterThanOrEqual(size.width);
        expect(spanned(cols - 1, cardWidth(LAYOUT))).toBeLessThan(size.width);
        expect(spanned(rows, cardHeight(LAYOUT))).toBeGreaterThanOrEqual(size.height);
    });

    it("sizes a nested custom group from its stored size, with the shared fallback", () => {
        const t = tree([
            group("root"),
            group("sized", { parent: "root", width: 900, height: 700 }),
            group("unsized", { parent: "root" })
        ]);
        const [sized, unsized] = childrenOf(t, "root");
        expect(nodeSize(t, sized, LAYOUT)).toEqual({ width: 900, height: 700 });
        expect(nodeSize(t, unsized, LAYOUT)).toEqual({ width: 400, height: 200 });
        expect(footprintOf(t, unsized, LAYOUT)).toEqual({ rows: 1, cols: 1 });
    });

    it("reports the widest child span as the grid's must-fit floor", () => {
        const t = tree(
            [group("root"), group("s1", { type: "series", parent: "root" })],
            [
                card("loose", { group_id: "root" }),
                ...Array.from({ length: 3 }, (_, i) =>
                    card(`c${i}`, { group_id: "s1", seriesIndex: i + 1 })
                )
            ]
        );
        expect(maxChildSpanCols(t, "root", LAYOUT)).toBe(3);
        expect(maxChildSpanCols(t, "s1", LAYOUT)).toBe(1);
        expect(maxChildSpanCols(t, "nope", LAYOUT)).toBe(0);
    });
});

describe("gridItemsOf", () => {
    it("reads a Card's position as container-relative and a Group's as absolute", () => {
        // ADR-0006: Group coordinates are absolute world at every depth, Card
        // coordinates are relative to their immediate container. A grid only
        // ever reasons in container-relative space.
        const t = tree(
            [
                group("root", { x: 1000, y: 600 }),
                group("child", { parent: "root", x: 1100, y: 700 })
            ],
            [card("c1", { group_id: "root", x: 40, y: 90 })]
        );
        const items = gridItemsOf(t, "root", LAYOUT, 3);
        expect(
            items.map((i) => ({ id: i.id, kind: i.kind, position: i.position }))
        ).toEqual([
            { id: "child", kind: "group", position: { x: 100, y: 100 } },
            { id: "c1", kind: "card", position: { x: 40, y: 90 } }
        ]);
    });

    it("derives each item's cell from the same lattice cellToPosition writes", () => {
        const target = cellToPosition({ row: 1, col: 2 }, LAYOUT);
        const t = tree(
            [group("root")],
            [card("c1", { group_id: "root", x: target.x, y: target.y })]
        );
        expect(gridItemsOf(t, "root", LAYOUT, 3)[0].cell).toEqual({ row: 1, col: 2 });
    });

    it("clamps a column past the grid's width, as positionToCell does", () => {
        const t = tree(
            [group("root")],
            [
                card("c1", {
                    group_id: "root",
                    x: GRID_PADDING + 9 * (cardWidth(LAYOUT) + GRID_CELL_GAP),
                    y: GRID_HEADER_HEIGHT + GRID_PADDING
                })
            ]
        );
        expect(gridItemsOf(t, "root", LAYOUT, 3)[0].cell).toEqual({ row: 0, col: 2 });
    });

    it("returns nothing for a group that is not in the tree", () => {
        expect(gridItemsOf(tree([group("root")]), "gone", LAYOUT, 3)).toEqual([]);
    });
});

// The assertion this whole slice exists for: a series must measure a whole
// number of grid columns, so its games land on the grid's own column rhythm.
describe("a series is exactly N grid columns wide", () => {
    it.each(ALL_LAYOUTS)("holds for %s at Bo1, Bo3 and Bo5", (layout) => {
        for (const games of [1, 3, 5]) {
            const columnSpan = games * cardWidth(layout) + (games - 1) * GRID_CELL_GAP;
            expect(getSeriesGroupDimensions(games, layout).width).toBe(columnSpan);
        }
    });
});
