import { childrenOf, type CanvasTree, type TreeNode } from "./canvasTree";

export type FreeGroupLeftRebaseWrite =
    | {
          kind: "card";
          draftId: string;
          positionX: number;
          positionY: number;
      }
    | {
          kind: "annotation";
          annotationId: string;
          positionX: number;
          positionY: number;
      };

const rebaseWriteFor = (
    node: TreeNode,
    expandLeft: number
): FreeGroupLeftRebaseWrite | undefined => {
    switch (node.kind) {
        case "group":
            // ADR-0006: Groups stay in absolute world coordinates at every depth.
            return undefined;
        case "card":
            return {
                kind: "card",
                draftId: node.card.Draft.id,
                positionX: node.card.positionX + expandLeft,
                positionY: node.card.positionY
            };
        case "annotation":
            return {
                kind: "annotation",
                annotationId: node.annotation.id,
                positionX: node.annotation.positionX + expandLeft,
                positionY: node.annotation.positionY
            };
        default: {
            const exhaustive: never = node;
            return exhaustive;
        }
    }
};

/** Rebase relative leaf coordinates when a free Group's left edge expands out. */
export const freeGroupLeftRebaseWrites = (
    tree: CanvasTree,
    groupId: string,
    expandLeft: number
): FreeGroupLeftRebaseWrite[] => {
    const writes: FreeGroupLeftRebaseWrite[] = [];
    for (const node of childrenOf(tree, groupId)) {
        const write = rebaseWriteFor(node, expandLeft);
        if (write) writes.push(write);
    }
    return writes;
};
