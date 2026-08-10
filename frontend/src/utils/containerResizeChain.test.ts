import { describe, expect, it } from "vitest";
import { resizeChainOf } from "./containerResizeChain";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

const grp = (id: string, parent: string | null): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    name: id,
    type: "custom",
    positionX: 0,
    positionY: 0,
    parent_group_id: parent,
    metadata: {}
});

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({ groups, drafts: [] });

describe("resizeChainOf", () => {
    it("is just the group itself at top level", () => {
        const tree = treeOf([grp("a", null)]);
        expect(resizeChainOf(tree, "a")).toEqual(["a"]);
    });

    it("is nearest-first up to the root", () => {
        const tree = treeOf([grp("root", null), grp("mid", "root"), grp("leaf", "mid")]);
        expect(resizeChainOf(tree, "leaf")).toEqual(["leaf", "mid", "root"]);
    });

    it("stops at a dangling parent — the optimistic-delete orphan case", () => {
        const tree = treeOf([grp("leaf", "gone")]);
        expect(resizeChainOf(tree, "leaf")).toEqual(["leaf"]);
    });

    it("terminates on a cycle instead of hanging the renderer", () => {
        const tree = treeOf([grp("a", "b"), grp("b", "a")]);
        expect(resizeChainOf(tree, "a")).toEqual(["a", "b"]);
    });

    it("is empty for a node that is not in the tree", () => {
        expect(resizeChainOf(treeOf([]), "ghost")).toEqual([]);
    });

    it("never repeats an id, so no container is resized twice in one pass", () => {
        const tree = treeOf([grp("root", null), grp("mid", "root"), grp("leaf", "mid")]);
        const chain = resizeChainOf(tree, "leaf");
        expect(new Set(chain).size).toBe(chain.length);
    });
});
