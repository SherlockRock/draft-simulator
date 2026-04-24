import { ContextMenuAction } from "../../utils/types";

export interface TreeActionContext {
    isConfirmed: boolean;
    /** True when this node is a direct child of the confirmed frontier (depth-1 projected). */
    isDepthOneProjected: boolean;
    hasLayoutOverride: boolean;
    onConfirmPick: () => void;
    onCollapseSubtree: () => void;
    onPromoteToScenario: () => void;
    onSwapChampion: () => void;
    onCreateBranch: () => void;
    onCopyChampionName: () => void;
    onResetNodeLayout: () => void;
}

/**
 * Returns menu items for a tree node. Confirmed vs projected matrix per Spec C.
 */
export function actionsForNode(ctx: TreeActionContext): ContextMenuAction[] {
    const actions: ContextMenuAction[] = [];

    if (!ctx.isConfirmed && ctx.isDepthOneProjected) {
        actions.push({
            label: "Confirm this pick",
            action: ctx.onConfirmPick
        });
    }

    actions.push({
        label: "Collapse subtree",
        action: ctx.onCollapseSubtree
    });

    if (!ctx.isConfirmed) {
        actions.push({
            label: "Promote to scenario lane",
            action: ctx.onPromoteToScenario
        });
        actions.push({
            label: "Swap champion",
            action: ctx.onSwapChampion,
            destructive: true
        });
        actions.push({
            label: "Create branch with champion…",
            action: ctx.onCreateBranch
        });
    }

    actions.push({
        label: "Copy champion name",
        action: ctx.onCopyChampionName
    });

    if (ctx.hasLayoutOverride) {
        actions.push({
            label: "Reset this node's layout",
            action: ctx.onResetNodeLayout
        });
    }

    return actions;
}

export function backgroundActions(
    _hasAnyOverrides: boolean,
    onResetAll: () => void
): ContextMenuAction[] {
    return [
        {
            label: "Reset all layout",
            action: onResetAll
        }
    ];
}
