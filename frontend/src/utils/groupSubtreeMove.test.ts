import { describe, it, expect } from "vitest";
import { subtreeMoveWrites } from "./groupSubtreeMove";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

const group = (
    id: string,
    opts: { parent?: string | null; x?: number; y?: number } = {}
): CanvasGroup => ({
    id,
    canvas_id: "c1",
    name: id,
    type: "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({ groups, drafts: [] });

describe("subtreeMoveWrites", () => {
    it("moves the group alone when it has no children", () => {
        const tree = treeOf([group("solo", { x: 10, y: 20 })]);
        expect(subtreeMoveWrites(tree, "solo", 5, -5)).toEqual([
            { id: "solo", positionX: 15, positionY: 15 }
        ]);
    });

    it("offsets every descendant from ITS OWN stored position, not the parent's", () => {
        const tree = treeOf([
            group("root", { x: 100, y: 100 }),
            group("child", { parent: "root", x: 150, y: 180 }),
            group("grandchild", { parent: "child", x: 160, y: 200 })
        ]);
        expect(subtreeMoveWrites(tree, "root", 30, -10)).toEqual([
            { id: "root", positionX: 130, positionY: 90 },
            { id: "child", positionX: 180, positionY: 170 },
            { id: "grandchild", positionX: 190, positionY: 190 }
        ]);
    });

    it("writes nothing for a zero delta", () => {
        const tree = treeOf([group("root"), group("child", { parent: "root" })]);
        expect(subtreeMoveWrites(tree, "root", 0, 0)).toEqual([]);
    });

    it("leaves unrelated groups and orphans alone", () => {
        const tree = treeOf([
            group("root", { x: 0, y: 0 }),
            group("other", { x: 900, y: 900 }),
            group("orphan", { parent: "gone", x: 50, y: 50 })
        ]);
        expect(subtreeMoveWrites(tree, "root", 10, 0).map((w) => w.id)).toEqual(["root"]);
    });

    it("terminates on a cycle instead of hanging", () => {
        const tree = treeOf([
            group("x", { parent: "y", x: 0, y: 0 }),
            group("y", { parent: "x", x: 10, y: 10 })
        ]);
        expect(subtreeMoveWrites(tree, "x", 1, 1)).toEqual([
            { id: "x", positionX: 1, positionY: 1 },
            { id: "y", positionX: 11, positionY: 11 }
        ]);
    });

    it("returns nothing for a group that is not in the tree", () => {
        expect(subtreeMoveWrites(treeOf([]), "ghost", 5, 5)).toEqual([]);
    });
});
