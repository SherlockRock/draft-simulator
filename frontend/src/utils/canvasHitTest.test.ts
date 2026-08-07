import { describe, it, expect } from "vitest";
import { findDropContainer, isPointInGroup } from "./canvasHitTest";
import { DEFAULT_GROUP_HEIGHT, DEFAULT_GROUP_WIDTH } from "./gridLayout";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

const group = (
    id: string,
    opts: {
        x?: number;
        y?: number;
        width?: number | null;
        height?: number | null;
        parent?: string | null;
        type?: "custom" | "series";
    } = {}
): CanvasGroup => ({
    id,
    canvas_id: "c1",
    name: id,
    type: opts.type ?? "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    width: opts.width === undefined ? 400 : opts.width,
    height: opts.height === undefined ? 300 : opts.height,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({ groups, drafts: [] });

describe("isPointInGroup", () => {
    it("uses the stored rect, edges inclusive", () => {
        const g = group("g", { x: 100, y: 100, width: 200, height: 50 });
        expect(isPointInGroup(100, 100, g)).toBe(true);
        expect(isPointInGroup(300, 150, g)).toBe(true);
        expect(isPointInGroup(301, 150, g)).toBe(false);
        expect(isPointInGroup(200, 151, g)).toBe(false);
    });

    it("falls back to the default container size", () => {
        const g = group("g", { width: null, height: null });
        expect(isPointInGroup(DEFAULT_GROUP_WIDTH, DEFAULT_GROUP_HEIGHT, g)).toBe(true);
        expect(isPointInGroup(DEFAULT_GROUP_WIDTH + 1, 0, g)).toBe(false);
    });
});

describe("findDropContainer", () => {
    it("returns null when the point is in nothing", () => {
        expect(findDropContainer(treeOf([group("a")]), { x: 9000, y: 9000 })).toBe(null);
    });

    it("returns the nested child for a point inside both", () => {
        const tree = treeOf([
            group("parent", { x: 0, y: 0, width: 800, height: 600 }),
            group("child", { x: 100, y: 100, width: 200, height: 200, parent: "parent" })
        ]);
        expect(findDropContainer(tree, { x: 150, y: 150 })?.id).toBe("child");
        expect(findDropContainer(tree, { x: 700, y: 500 })?.id).toBe("parent");
    });

    it("still returns the child where it overhangs its parent", () => {
        // Nothing clips (§6.2), so a child's rect can extend outside the frame
        // that owns it, and it still paints last within that subtree.
        const tree = treeOf([
            group("parent", { x: 0, y: 0, width: 400, height: 400 }),
            group("child", { x: 300, y: 300, width: 400, height: 400, parent: "parent" })
        ]);
        expect(findDropContainer(tree, { x: 650, y: 650 })?.id).toBe("child");
    });

    // The counterexample that killed depth ranking: B is a ROOT, shallower than
    // A1, but it paints after A's whole subtree — so it is what the user sees.
    it("resolves an unrelated overlap the way the screen paints it", () => {
        const tree = treeOf([
            group("a", { x: 0, y: 0, width: 400, height: 400 }),
            group("a1", { x: 300, y: 300, width: 400, height: 400, parent: "a" }),
            group("b", { x: 500, y: 500, width: 400, height: 400 })
        ]);
        expect(findDropContainer(tree, { x: 600, y: 600 })?.id).toBe("b");
    });

    it("never returns a series", () => {
        const tree = treeOf([
            group("bo3", { x: 0, y: 0, width: 2000, height: 800, type: "series" })
        ]);
        expect(findDropContainer(tree, { x: 100, y: 100 })).toBe(null);
    });

    it("excludes the dragged node and its whole subtree", () => {
        const tree = treeOf([
            group("outer", { x: 0, y: 0, width: 900, height: 900 }),
            group("dragged", { x: 50, y: 50, width: 700, height: 700, parent: "outer" }),
            group("inner", { x: 100, y: 100, width: 300, height: 300, parent: "dragged" })
        ]);
        expect(findDropContainer(tree, { x: 200, y: 200 })?.id).toBe("inner");
        expect(
            findDropContainer(tree, { x: 200, y: 200 }, { excludeSubtreeOf: "dragged" })
                ?.id
        ).toBe("outer");
    });

    it("returns null when the only candidates are excluded", () => {
        const tree = treeOf([
            group("dragged", { x: 0, y: 0, width: 400, height: 400 }),
            group("inner", { x: 50, y: 50, width: 100, height: 100, parent: "dragged" })
        ]);
        expect(
            findDropContainer(tree, { x: 80, y: 80 }, { excludeSubtreeOf: "dragged" })
        ).toBe(null);
    });

    it("tolerates a cycle instead of hanging", () => {
        const tree = treeOf([
            group("x", { x: 0, y: 0, width: 400, height: 400, parent: "y" }),
            group("y", { x: 0, y: 0, width: 400, height: 400, parent: "x" })
        ]);
        expect(findDropContainer(tree, { x: 10, y: 10 })).not.toBe(null);
    });
});
