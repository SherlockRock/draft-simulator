import { describe, expect, it } from "vitest";
import type { CanvasTree } from "./canvasTree";
import { freeGroupLeftRebaseWrites } from "./freeGroupLeftRebase";
import type { CanvasAnnotation, CanvasDraft, CanvasGroup } from "./schemas";

const group = (id: string, parentGroupId: string | null): CanvasGroup => ({
    id,
    canvas_id: "canvas-1",
    parent_group_id: parentGroupId,
    name: id,
    type: "custom",
    positionX: 100,
    positionY: 200,
    width: 400,
    height: 300,
    metadata: {}
});

const card = (groupId: string): CanvasDraft => ({
    draft_id: "card-1",
    group_id: groupId,
    positionX: 12,
    positionY: 34,
    source_type: "canvas",
    Draft: {
        id: "card-1",
        name: "card-1",
        picks: Array(20).fill(""),
        type: "canvas"
    }
});

const annotation = (groupId: string): CanvasAnnotation => ({
    id: "annotation-1",
    canvas_id: "canvas-1",
    group_id: groupId,
    positionX: -8,
    positionY: 56,
    width: 200,
    height: 100,
    text: "note",
    color: "slate",
    fontSize: "md"
});

describe("freeGroupLeftRebaseWrites", () => {
    it("rebases relative Cards and annotations but not absolute child Groups", () => {
        const tree: CanvasTree = {
            groups: [group("parent", null), group("child", "parent")],
            drafts: [card("parent")],
            annotations: [annotation("parent")]
        };

        expect(freeGroupLeftRebaseWrites(tree, "parent", 20)).toEqual([
            {
                kind: "card",
                draftId: "card-1",
                positionX: 32,
                positionY: 34
            },
            {
                kind: "annotation",
                annotationId: "annotation-1",
                positionX: 12,
                positionY: 56
            }
        ]);
    });
});
