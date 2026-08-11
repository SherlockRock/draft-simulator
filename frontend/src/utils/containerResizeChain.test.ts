import { describe, expect, it } from "vitest";
import { groupDragResyncTargets, resizeChainOf } from "./containerResizeChain";
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

/**
 * The Card drag path has always resynced on a same-container reposition and on
 * the container a Card LEFT. The Group drag path did neither: it resynced only
 * `nextParentId`, and only when parentage changed into it. So a series moved
 * further up inside its free parent never shrank the parent, and a Group
 * dragged out to top level never shrank the one it left.
 */
describe("groupDragResyncTargets", () => {
    it("resyncs the parent a Group was repositioned INSIDE — the reported defect", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: "free-parent",
                nextParentId: "free-parent",
                rejected: false
            })
        ).toEqual(["free-parent"]);
    });

    it("resyncs BOTH containers on a move between them, source first", () => {
        // Source first so the container losing a member settles before the one
        // gaining it, matching the Card path's ordering.
        expect(
            groupDragResyncTargets({
                previousParentId: "from",
                nextParentId: "to",
                rejected: false
            })
        ).toEqual(["from", "to"]);
    });

    it("resyncs the abandoned parent when a Group is dragged out to top level", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: "from",
                nextParentId: null,
                rejected: false
            })
        ).toEqual(["from"]);
    });

    it("resyncs the gaining container when a top-level Group is dropped in", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: null,
                nextParentId: "to",
                rejected: false
            })
        ).toEqual(["to"]);
    });

    it("is empty for a top-level Group moved around the canvas", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: null,
                nextParentId: null,
                rejected: false
            })
        ).toEqual([]);
    });

    /**
     * A rejected drop commits the POSITION only, so parentage is unchanged and
     * `nextParentId` describes a move that did not happen. The Group still
     * moved inside the parent it kept, which still has to re-fit.
     */
    it("ignores the proposed parent on a rejected drop and refits the one it kept", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: "kept",
                nextParentId: "refused",
                rejected: true
            })
        ).toEqual(["kept"]);
    });

    it("is empty for a rejected drop by a top-level Group", () => {
        expect(
            groupDragResyncTargets({
                previousParentId: null,
                nextParentId: "refused",
                rejected: true
            })
        ).toEqual([]);
    });
});
