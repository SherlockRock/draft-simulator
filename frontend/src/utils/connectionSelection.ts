import type { AnchorType } from "./schemas";

export type ConnectionEndpointKind = "draft" | "group" | "annotation";
export type ConnectionEndpointRef = { kind: ConnectionEndpointKind; id: string };
export type ConnectionSelection = {
    ref: ConnectionEndpointRef;
    anchor: AnchorType;
};

export type ConnectionEndpointInput =
    | { draftId: string; anchorType?: AnchorType }
    | { groupId: string; anchorType?: AnchorType }
    | { annotationId: string; anchorType?: AnchorType };

export const endpointInputFor = (
    ref: ConnectionEndpointRef,
    anchor?: AnchorType
): ConnectionEndpointInput => {
    switch (ref.kind) {
        case "draft":
            return { draftId: ref.id, anchorType: anchor };
        case "group":
            return { groupId: ref.id, anchorType: anchor };
        case "annotation":
            return { annotationId: ref.id, anchorType: anchor };
    }
};

export type AnchorClickAction =
    | { kind: "select"; selection: ConnectionSelection }
    | {
          kind: "create";
          source: ConnectionSelection;
          target: ConnectionSelection;
      }
    | { kind: "clear" };

export const resolveAnchorClick = (
    current: ConnectionSelection | null,
    clicked: ConnectionSelection
): AnchorClickAction => {
    if (!current) return { kind: "select", selection: clicked };
    if (current.ref.kind === clicked.ref.kind && current.ref.id === clicked.ref.id) {
        return { kind: "clear" };
    }
    return { kind: "create", source: current, target: clicked };
};
