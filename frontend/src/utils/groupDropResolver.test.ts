import { describe, it, expect } from "vitest";
import { MAX_GROUP_DEPTH } from "@draft-sim/shared-types/canvas-tree-vector";
import { resolveGroupDrop } from "./groupDropResolver";
import { PARENTAGE_REJECTIONS } from "./groupParentage";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

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
    canvas_id: "c1",
    name: id,
    type: opts.type ?? "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    width: opts.width ?? 400,
    height: opts.height ?? 300,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({
    groups,
    drafts: [],
    annotations: []
});

describe("resolveGroupDrop", () => {
    it("nests into the container under the dragged Group's top-left corner", () => {
        const tree = treeOf([
            group("target", { x: 0, y: 0, width: 900, height: 900 }),
            group("dragged", { x: 100, y: 100 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 100, y: 100 } })
        ).toEqual({ nextParentId: "target" });
    });

    it("un-nests when the corner clears every container", () => {
        const tree = treeOf([
            group("parent", { x: 0, y: 0, width: 400, height: 400 }),
            group("dragged", { parent: "parent", x: 5000, y: 5000 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 5000, y: 5000 } })
        ).toEqual({ nextParentId: null });
    });

    it("resolves the deepest container the corner is inside", () => {
        const tree = treeOf([
            group("outer", { x: 0, y: 0, width: 900, height: 900 }),
            group("inner", { parent: "outer", x: 100, y: 100, width: 400, height: 400 }),
            group("dragged", { x: 4000, y: 4000 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 200, y: 200 } })
        ).toEqual({ nextParentId: "inner" });
    });

    it("never resolves the dragged Group itself or its own subtree", () => {
        const tree = treeOf([
            group("dragged", { x: 0, y: 0, width: 900, height: 900 }),
            group("child", { parent: "dragged", x: 100, y: 100, width: 400, height: 400 })
        ]);
        // The corner sits inside both, and both are excluded — so top level.
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 150, y: 150 } })
        ).toEqual({ nextParentId: null });
    });

    it("is a no-op when the Group lands back in its own parent", () => {
        const tree = treeOf([
            group("parent", { x: 0, y: 0, width: 900, height: 900 }),
            group("dragged", { parent: "parent", x: 100, y: 100 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 300, y: 300 } })
        ).toEqual({ nextParentId: "parent" });
    });

    it("rejects a drop that would put the subtree past the depth cap", () => {
        const chain = Array.from({ length: MAX_GROUP_DEPTH + 1 }, (_, i) =>
            group(`d${i}`, {
                ...(i === 0 ? {} : { parent: `d${i - 1}` }),
                x: 0,
                y: 0,
                width: 900,
                height: 900
            })
        );
        const tree = treeOf([...chain, group("dragged", { x: 5000, y: 5000 })]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 10, y: 10 } })
        ).toEqual({ rejection: PARENTAGE_REJECTIONS.tooDeep });
    });

    it("never offers a series as a container", () => {
        // A series is not a drop candidate at all, so the corner resolves past
        // it — the "inside a series" rejection is unreachable through a drag.
        const tree = treeOf([
            group("bo3", { type: "series", x: 0, y: 0, width: 3600, height: 800 }),
            group("dragged", { x: 5000, y: 5000 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "dragged", point: { x: 100, y: 100 } })
        ).toEqual({ nextParentId: null });
    });

    it("lets a series be nested — it is a legal CHILD, only never a parent", () => {
        const tree = treeOf([
            group("target", { x: 0, y: 0, width: 900, height: 900 }),
            group("bo3", { type: "series", x: 5000, y: 5000 })
        ]);
        expect(
            resolveGroupDrop(tree, { groupId: "bo3", point: { x: 100, y: 100 } })
        ).toEqual({ nextParentId: "target" });
    });
});
