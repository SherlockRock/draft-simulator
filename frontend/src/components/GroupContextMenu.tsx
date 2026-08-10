import { Component } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { ContextMenuAction } from "../utils/types";
import { ContextMenu } from "./ContextMenu";

type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename?: () => void;
    onSetTeamNames?: () => void;
    onViewSeries?: () => void;
    onMoveToTopLevel?: () => void;
    onGoTo: () => void;
    onDelete: () => void;
    onClose: () => void;
};

export const GroupContextMenu: Component<GroupContextMenuProps> = (props) => {
    const actions = (): ContextMenuAction[] => {
        const menuActions: ContextMenuAction[] = [];

        if (props.group.type === "custom") {
            menuActions.push({
                label: "Rename",
                action: () => props.onRename?.()
            });

            if (props.onSetTeamNames) {
                menuActions.push({
                    label: "Set team names…",
                    action: () => props.onSetTeamNames?.()
                });
            }

            // Layout — grid on/off, columns, rows and labels — lives entirely
            // in the group settings dialog now. It used to be three entries
            // here ("Arrange as grid…", "Grid settings…", "Convert to free
            // layout") against a separate dialog, which meant an existing grid
            // group had two places to edit the same columns.
        }

        // The guaranteed un-nest affordance, and the escape hatch for a child
        // dragged outside its parent — which would otherwise sit there locking
        // the parent's left edge with no way back (design decision 9, pulled
        // forward from 5a-3). Series can be nested too, so this is not inside
        // the custom-only block.
        if (props.group.parent_group_id && props.onMoveToTopLevel) {
            menuActions.push({
                label: "Move to top level",
                action: () => props.onMoveToTopLevel?.()
            });
        }

        if (props.group.type === "series" && props.group.metadata.origin !== "manual") {
            menuActions.push({
                label: "View series",
                action: () => props.onViewSeries?.()
            });
        }

        menuActions.push(
            { label: "Go to", action: () => props.onGoTo() },
            {
                label: "Delete",
                action: () => props.onDelete(),
                destructive: true
            }
        );

        return menuActions;
    };

    return (
        <ContextMenu
            class="group-context-menu"
            header={props.group.name}
            position={props.position}
            actions={actions()}
            onClose={props.onClose}
        />
    );
};
