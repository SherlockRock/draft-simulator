import { describe, expect, it } from "vitest";
import {
    endpointInputFor,
    resolveAnchorClick,
    type ConnectionEndpointKind,
    type ConnectionSelection
} from "./connectionSelection";

const selection = (
    kind: ConnectionEndpointKind,
    id: string,
    anchor: ConnectionSelection["anchor"]
): ConnectionSelection => ({ ref: { kind, id }, anchor });

describe("endpointInputFor", () => {
    it("builds the wire input for every endpoint kind", () => {
        expect(endpointInputFor({ kind: "draft", id: "draft-1" }, "left")).toEqual({
            draftId: "draft-1",
            anchorType: "left"
        });
        expect(endpointInputFor({ kind: "group", id: "group-1" }, "top")).toEqual({
            groupId: "group-1",
            anchorType: "top"
        });
        expect(
            endpointInputFor({ kind: "annotation", id: "annotation-1" }, "right")
        ).toEqual({ annotationId: "annotation-1", anchorType: "right" });
    });

    it("omits no endpoint identity when the anchor is absent", () => {
        expect(endpointInputFor({ kind: "draft", id: "draft-1" })).toEqual({
            draftId: "draft-1",
            anchorType: undefined
        });
    });
});

describe("resolveAnchorClick", () => {
    it("selects each endpoint kind when there is no current selection", () => {
        for (const kind of [
            "draft",
            "group",
            "annotation"
        ] satisfies Array<ConnectionEndpointKind>) {
            const clicked = selection(kind, `${kind}-1`, "left");
            expect(resolveAnchorClick(null, clicked)).toEqual({
                kind: "select",
                selection: clicked
            });
        }
    });

    it("creates with each endpoint kind as the source", () => {
        for (const kind of [
            "draft",
            "group",
            "annotation"
        ] satisfies Array<ConnectionEndpointKind>) {
            const source = selection(kind, `${kind}-1`, "left");
            const target = selection("draft", "draft-target", "right");
            expect(resolveAnchorClick(source, target)).toEqual({
                kind: "create",
                source,
                target
            });
        }
    });

    it("creates with each endpoint kind as the target", () => {
        for (const kind of [
            "draft",
            "group",
            "annotation"
        ] satisfies Array<ConnectionEndpointKind>) {
            const source = selection("draft", "draft-source", "left");
            const target = selection(kind, `${kind}-target`, "right");
            expect(resolveAnchorClick(source, target)).toEqual({
                kind: "create",
                source,
                target
            });
        }
    });

    it("clears when the same node is clicked on a different anchor", () => {
        for (const kind of [
            "draft",
            "group",
            "annotation"
        ] satisfies Array<ConnectionEndpointKind>) {
            expect(
                resolveAnchorClick(
                    selection(kind, `${kind}-1`, "left"),
                    selection(kind, `${kind}-1`, "right")
                )
            ).toEqual({ kind: "clear" });
        }
    });

    it("creates when the ids match but the endpoint kinds differ", () => {
        const source = selection("group", "shared-id", "left");
        const target = selection("annotation", "shared-id", "right");

        expect(resolveAnchorClick(source, target)).toEqual({
            kind: "create",
            source,
            target
        });
    });
});
