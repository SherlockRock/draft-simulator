import { CanvasGroup } from "../utils/schemas";
import {
    containerContentsLabel,
    type ContainerContents
} from "../utils/containerContents";
import { EscapeKeyHint, ReturnKeyHint } from "./Dialog";

type DeleteGroupDialogProps = {
    group: CanvasGroup;
    /** Direct child Cards, Groups and notes affected by the deletion choice. */
    contents: ContainerContents;
    onKeepDrafts: () => void;
    onDeleteAll: () => void;
    onCancel: () => void;
};

export const DeleteGroupDialog = (props: DeleteGroupDialogProps) => {
    return (
        <div>
            <h3 class="mb-4 text-lg font-bold text-darius-text-primary">
                Remove Group from Canvas?
            </h3>
            <p class="mb-3 text-darius-text-primary">
                This will remove "{props.group.name}" from this canvas.
            </p>
            <p class="mb-6 text-sm text-darius-text-secondary">
                It contains {containerContentsLabel(props.contents)}. You can keep those
                on the canvas or remove them with the group.
            </p>
            <div class="flex justify-end gap-3">
                <button
                    onClick={props.onCancel}
                    class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                >
                    <span>Cancel</span>
                    <EscapeKeyHint />
                </button>
                <button
                    onClick={props.onKeepDrafts}
                    class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                >
                    <span>Remove Group Only</span>
                    <ReturnKeyHint />
                </button>
                <button
                    onClick={props.onDeleteAll}
                    class="rounded-md bg-darius-crimson px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                >
                    Remove Group and Contents
                </button>
            </div>
        </div>
    );
};
