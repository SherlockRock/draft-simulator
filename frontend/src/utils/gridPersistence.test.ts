import { describe, it, expect } from "vitest";
import { splitGridPlacements } from "./gridPersistence";
import type { CanvasTree } from "./canvasTree";
import type { CanvasGroup } from "./schemas";
import type { GridPlacement } from "./gridLayout";

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

const treeOf = (groups: CanvasGroup[]): CanvasTree => ({
    groups,
    drafts: [],
    annotations: []
});

const card = (id: string, x: number, y: number): GridPlacement => ({
    id,
    kind: "card",
    positionX: x,
    positionY: y
});

const nested = (id: string, x: number, y: number): GridPlacement => ({
    id,
    kind: "group",
    positionX: x,
    positionY: y
});

const annotation = (id: string, x: number, y: number): GridPlacement => ({
    id,
    kind: "annotation",
    positionX: x,
    positionY: y
});

describe("splitGridPlacements", () => {
    it("keeps Card placements container-relative and verbatim", () => {
        const parent = group("P", { x: 1000, y: 500 });
        const { positions, groups } = splitGridPlacements({
            tree: treeOf([parent]),
            parent,
            placements: [card("c1", 16, 64)]
        });
        expect(positions).toEqual([{ draft_id: "c1", positionX: 16, positionY: 64 }]);
        expect(groups).toEqual([]);
    });

    it("rebases Group placements to absolute world (ADR-0006)", () => {
        const parent = group("P", { x: 1000, y: 500 });
        const child = group("C", { parent: "P", x: 1200, y: 700 });
        const { groups, positions } = splitGridPlacements({
            tree: treeOf([parent, child]),
            parent,
            placements: [nested("C", 16, 64)]
        });
        expect(positions).toEqual([]);
        expect(groups).toEqual([{ id: "C", positionX: 1016, positionY: 564 }]);
    });

    it("carries the moved Group's whole subtree in the store writes", () => {
        const parent = group("P", { x: 0, y: 0 });
        const child = group("C", { parent: "P", x: 100, y: 100 });
        const grandchild = group("G", { parent: "C", x: 140, y: 160 });
        const { groupStoreWrites } = splitGridPlacements({
            tree: treeOf([parent, child, grandchild]),
            parent,
            placements: [nested("C", 16, 64)]
        });
        // C moves by (-84, -36); G rides along from ITS OWN stored position.
        expect(groupStoreWrites).toEqual([
            { id: "C", positionX: 16, positionY: 64 },
            { id: "G", positionX: 56, positionY: 124 }
        ]);
    });

    it("writes nothing to the store for a Group that did not actually move", () => {
        const parent = group("P", { x: 0, y: 0 });
        const child = group("C", { parent: "P", x: 16, y: 64 });
        const { groups, groupStoreWrites } = splitGridPlacements({
            tree: treeOf([parent, child]),
            parent,
            placements: [nested("C", 16, 64)]
        });
        // Still on the wire — the commit is what makes it authoritative.
        expect(groups).toEqual([{ id: "C", positionX: 16, positionY: 64 }]);
        expect(groupStoreWrites).toEqual([]);
    });

    it("handles a Group entering the grid from outside the store", () => {
        const parent = group("P", { x: 200, y: 200 });
        const { groups, groupStoreWrites } = splitGridPlacements({
            tree: treeOf([parent]),
            parent,
            placements: [nested("incoming", 16, 64)]
        });
        expect(groups).toEqual([{ id: "incoming", positionX: 216, positionY: 264 }]);
        expect(groupStoreWrites).toEqual([
            { id: "incoming", positionX: 216, positionY: 264 }
        ]);
    });

    it("splits a mixed batch by kind", () => {
        const parent = group("P", { x: 10, y: 10 });
        const child = group("C", { parent: "P", x: 0, y: 0 });
        const { positions, groups } = splitGridPlacements({
            tree: treeOf([parent, child]),
            parent,
            placements: [card("c1", 16, 64), nested("C", 400, 64), card("c2", 800, 64)]
        });
        expect(positions.map((p) => p.draft_id)).toEqual(["c1", "c2"]);
        expect(groups).toEqual([{ id: "C", positionX: 410, positionY: 74 }]);
    });
});

describe("annotation persistence buckets", () => {
    it("always returns an empty annotations array when no annotations are placed", () => {
        const parent = group("P", { x: 1000, y: 500 });

        const writes = splitGridPlacements({
            tree: treeOf([parent]),
            parent,
            placements: [card("C", 16, 24)]
        });

        expect(writes.annotations).toEqual([]);
    });

    it("routes a mixed Card, Group, and annotation reflow by kind", () => {
        const parent = group("P", { x: 1000, y: 500 });
        const child = group("G", { parent: "P", x: 1200, y: 700 });

        const writes = splitGridPlacements({
            tree: treeOf([parent, child]),
            parent,
            placements: [
                card("C", 16, 24),
                nested("G", 220, 24),
                annotation("A", 420, 24)
            ]
        });

        expect(writes.positions).toEqual([
            { draft_id: "C", positionX: 16, positionY: 24 }
        ]);
        expect(writes.groups).toEqual([{ id: "G", positionX: 1220, positionY: 524 }]);
        expect(writes.annotations).toEqual([{ id: "A", positionX: 420, positionY: 24 }]);
    });

    it("persists the D13 zero-Card champion pool entirely as annotations", () => {
        const parent: CanvasGroup = {
            ...group("champion-pool", { x: 1000, y: 500 }),
            metadata: {
                layout: "grid",
                rowLabels: ["S", "A", "Situational"]
            }
        };

        const writes = splitGridPlacements({
            tree: treeOf([parent]),
            parent,
            placements: [
                annotation("note-s", 16, 24),
                annotation("note-a", 16, 168),
                annotation("note-situational", 16, 312)
            ]
        });

        expect(parent.type).toBe("custom");
        expect(parent.metadata).toEqual({
            layout: "grid",
            rowLabels: ["S", "A", "Situational"]
        });
        expect(writes.positions).toEqual([]);
        expect(writes.groups).toEqual([]);
        expect(writes.annotations).toEqual([
            { id: "note-s", positionX: 16, positionY: 24 },
            { id: "note-a", positionX: 16, positionY: 168 },
            { id: "note-situational", positionX: 16, positionY: 312 }
        ]);
        expect(writes.groupStoreWrites).toEqual([]);
    });
});

// The contract the two grid commit seams depend on. `groups` is the WIRE
// payload -- direct placements only, because the server fans the delta out over
// descendantGroupsOf. `groupStoreWrites` is the whole subtree, which is what a
// local canvas must persist: localUpdateDraftPositions applies entries verbatim
// and fans nothing out, so sending `groups` there strands the grandchildren.
describe("local payloads need the subtree, not just the direct placements", () => {
    it("carries every descendant Group row in groupStoreWrites", () => {
        const parent = group("P", { x: 1000, y: 500 });
        const child = group("C", { parent: "P", x: 1200, y: 700 });
        const grandchild = group("G", { parent: "C", x: 1250, y: 750 });

        const writes = splitGridPlacements({
            tree: treeOf([parent, child, grandchild]),
            parent,
            placements: [nested("C", 16, 64)]
        });

        expect(writes.groups.map((g) => g.id)).toEqual(["C"]);
        expect(writes.groupStoreWrites.map((g) => g.id)).toEqual(["C", "G"]);
        // The grandchild travels by the same delta as the moved container.
        expect(writes.groupStoreWrites).toContainEqual({
            id: "G",
            positionX: 1250 + (1016 - 1200),
            positionY: 750 + (564 - 700)
        });
    });
});
