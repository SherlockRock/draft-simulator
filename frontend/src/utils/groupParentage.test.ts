import { describe, it, expect } from "vitest";
import { MAX_GROUP_DEPTH } from "@draft-sim/shared-types/canvas-tree-vector";
import { PARENTAGE_REJECTIONS, parentageRejection } from "./groupParentage";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";

const group = (
    id: string,
    opts: { parent?: string | null; type?: "custom" | "series" } = {}
): CanvasGroup => ({
    id,
    canvas_id: "c1",
    name: id,
    type: opts.type ?? "custom",
    positionX: 0,
    positionY: 0,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({ groups, drafts: [] });

/** `d0` at top level down to `d{depth}`. */
const chain = (depth: number) =>
    Array.from({ length: depth + 1 }, (_, i) =>
        group(`d${i}`, i === 0 ? {} : { parent: `d${i - 1}` })
    );

describe("parentageRejection", () => {
    it("permits a legal nest and permits un-nesting", () => {
        const tree = treeOf([group("parent"), group("child", { parent: "parent" })]);
        expect(parentageRejection(tree, "child", null)).toBe(null);
        expect(parentageRejection(tree, "other", "parent")).toBe(null);
    });

    it("rejects a parent that is not on the canvas", () => {
        expect(parentageRejection(treeOf([group("a")]), "a", "ghost")).toBe(
            PARENTAGE_REJECTIONS.notOnCanvas
        );
    });

    it("rejects a series parent", () => {
        const tree = treeOf([group("a"), group("bo3", { type: "series" })]);
        expect(parentageRejection(tree, "a", "bo3")).toBe(
            PARENTAGE_REJECTIONS.intoSeries
        );
    });

    it("rejects a self-nest and a descendant-nest", () => {
        const tree = treeOf([
            group("root"),
            group("mid", { parent: "root" }),
            group("leaf", { parent: "mid" })
        ]);
        expect(parentageRejection(tree, "root", "root")).toBe(
            PARENTAGE_REJECTIONS.intoSelf
        );
        expect(parentageRejection(tree, "root", "leaf")).toBe(
            PARENTAGE_REJECTIONS.intoSelf
        );
    });

    it("rejects a move that puts the SUBTREE's leaf past the cap, not just the node", () => {
        // A 1-tall subtree under a parent at the cap's last legal depth.
        const tree = treeOf([
            ...chain(MAX_GROUP_DEPTH - 1),
            group("mover"),
            group("moverChild", { parent: "mover" })
        ]);
        // The mover alone would land exactly on the cap; its child would not.
        expect(parentageRejection(tree, "mover", `d${MAX_GROUP_DEPTH - 1}`)).toBe(
            PARENTAGE_REJECTIONS.tooDeep
        );
        expect(parentageRejection(tree, "mover", `d${MAX_GROUP_DEPTH - 2}`)).toBe(null);
    });

    it("measures a node that does not exist yet (the create path)", () => {
        const deep = treeOf(chain(MAX_GROUP_DEPTH));
        expect(parentageRejection(deep, "brand-new", `d${MAX_GROUP_DEPTH}`)).toBe(
            PARENTAGE_REJECTIONS.tooDeep
        );
        expect(parentageRejection(deep, "brand-new", `d${MAX_GROUP_DEPTH - 1}`)).toBe(
            null
        );
    });

    it("checks series-leaf before depth, matching the server's order", () => {
        const tree = treeOf([
            ...chain(MAX_GROUP_DEPTH),
            group("bo3", { parent: `d${MAX_GROUP_DEPTH}`, type: "series" })
        ]);
        expect(parentageRejection(tree, "x", "bo3")).toBe(
            PARENTAGE_REJECTIONS.intoSeries
        );
    });
});
