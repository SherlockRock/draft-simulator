import { describe, expect, it } from "vitest";
import { createEmptyLocalCanvas, localCanvasResource } from "./localCanvasStore";
import type { LocalCanvas } from "./localCanvasStore";
import type { CanvasAnnotation, CanvasDraft, CanvasGroup } from "./schemas";

const note = (id: string): CanvasAnnotation => ({
    id,
    canvas_id: "local",
    group_id: null,
    positionX: 10,
    positionY: 20,
    width: 380,
    height: 120,
    text: `note ${id}`,
    color: "slate",
    fontSize: "md",
    manualWidth: null,
    manualHeight: null
});

const card = (id: string): CanvasDraft => ({
    draft_id: id,
    group_id: null,
    positionX: 0,
    positionY: 0,
    Draft: { id, name: id, type: "canvas", picks: [] }
});

const group = (id: string): CanvasGroup => ({
    id,
    canvas_id: "local",
    name: id,
    type: "custom",
    positionX: 0,
    positionY: 0,
    parent_group_id: null,
    width: 400,
    height: 300,
    metadata: {}
});

const populated = (): LocalCanvas => ({
    ...createEmptyLocalCanvas("Fixture", "desc", "icon", "wide"),
    drafts: [card("d1")],
    groups: [group("g1")],
    annotations: [note("a1"), note("a2")],
    viewport: { x: 5, y: 6, zoom: 0.5 }
});

describe("localCanvasResource", () => {
    // The regression this exists for: the anonymous canvas resource carried a
    // hardcoded `annotations: []` beside siblings that all read from the store,
    // so a local canvas rendered NO notes until some later mutation happened to
    // refresh it. The write path was never at fault.
    it("carries the stored annotations, not an empty list", () => {
        const local = populated();

        expect(localCanvasResource(local).annotations).toEqual(local.annotations);
    });

    it("carries every other stored collection through unchanged", () => {
        const local = populated();
        const resource = localCanvasResource(local);

        expect(resource.drafts).toEqual(local.drafts);
        expect(resource.groups).toEqual(local.groups);
        expect(resource.connections).toEqual(local.connections);
        expect(resource.lastViewport).toEqual(local.viewport);
        expect(resource.cardLayout).toBe("wide");
    });

    // A LocalCanvas key that the mapper forgets renders as absent/empty rather
    // than failing anything, which is exactly how the annotations bug survived.
    // Enumerating the keys makes the next omission fail here instead.
    it("maps every collection key LocalCanvas defines", () => {
        const local = populated();
        const resource = localCanvasResource(local);
        const carried: Record<string, unknown[]> = {
            drafts: resource.drafts,
            groups: resource.groups,
            connections: resource.connections,
            annotations: resource.annotations
        };

        for (const key of ["drafts", "groups", "connections", "annotations"]) {
            expect(carried[key], `${key} is missing from the resource mapping`).toEqual(
                local[key as "drafts" | "groups" | "connections" | "annotations"]
            );
        }
    });

    it("keeps an empty canvas empty rather than undefined", () => {
        const resource = localCanvasResource(createEmptyLocalCanvas("Empty"));

        expect(resource.annotations).toEqual([]);
        expect(resource.userPermissions).toBe("admin");
        expect(resource.id).toBe("local");
    });
});
