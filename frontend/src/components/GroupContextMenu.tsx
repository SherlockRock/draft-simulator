import { Component } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { ContextMenuAction } from "../utils/types";
import { ContextMenu } from "./ContextMenu";

type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename?: () => void;
    onViewSeries?: () => void;
    onArrangeGrid?: () => void;
    onConvertToFree?: () => void;
    onGridSettings?: () => void;
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

            if (props.group.metadata.layout !== "grid") {
                menuActions.push({
                    label: "Arrange as grid…",
                    action: () => props.onArrangeGrid?.()
                });
            }

            if (props.group.metadata.layout === "grid") {
                menuActions.push(
                    {
                        label: "Grid settings…",
                        action: () => props.onGridSettings?.()
                    },
                    {
                        label: "Convert to free layout",
                        action: () => props.onConvertToFree?.()
                    }
                );
            }
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
