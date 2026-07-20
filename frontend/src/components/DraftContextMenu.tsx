import { Component } from "solid-js";
import { CanvasDraft } from "../utils/schemas";
import { ContextMenuAction } from "../utils/types";
import { ContextMenu } from "./ContextMenu";

type DraftContextMenuProps = {
    position: { x: number; y: number };
    draft: CanvasDraft;
    onRename?: () => void;
    onView: () => void;
    onGoTo: () => void;
    onCopy?: () => void;
    onDelete?: () => void;
    onClose: () => void;
};

export const DraftContextMenu: Component<DraftContextMenuProps> = (props) => {
    const actions = (): ContextMenuAction[] => {
        const menuActions: ContextMenuAction[] = [];

        if (props.onRename) {
            menuActions.push({
                label: "Rename",
                action: () => props.onRename?.()
            });
        }

        menuActions.push(
            { label: "View draft", action: () => props.onView() },
            { label: "Go to", action: () => props.onGoTo() }
        );

        if (props.onCopy) {
            menuActions.push({
                label: "Copy",
                action: () => props.onCopy?.()
            });
        }

        if (props.onDelete) {
            menuActions.push({
                label: "Delete",
                action: () => props.onDelete?.(),
                destructive: true
            });
        }

        return menuActions;
    };

    return (
        <ContextMenu
            class="draft-context-menu"
            header={props.draft.Draft.name}
            position={props.position}
            actions={actions()}
            onClose={props.onClose}
        />
    );
};
