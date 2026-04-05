import { CanvasGroup } from "../utils/schemas";

type DeleteGroupDialogProps = {
    group: CanvasGroup;
    draftCount: number;
    onKeepDrafts: () => void;
    onDeleteAll: () => void;
    onCancel: () => void;
};

export const DeleteGroupDialog = (props: DeleteGroupDialogProps) => {
    return (
        <div>
            <h3 class="mb-4 text-lg font-bold text-darius-text-primary">
                Delete group "{props.group.name}"?
            </h3>
            <p class="mb-6 text-darius-text-primary">
                This group contains {props.draftCount} draft
                {props.draftCount !== 1 ? "s" : ""}.
            </p>
            <div class="flex justify-end gap-3">
                <button
                    onClick={props.onCancel}
                    class="rounded-md bg-darius-card-hover px-4 py-2 text-darius-text-primary transition-colors hover:bg-darius-border"
                >
                    Cancel
                </button>
                <button
                    onClick={props.onKeepDrafts}
                    class="rounded-md bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                >
                    Keep Drafts
                </button>
                <button
                    onClick={props.onDeleteAll}
                    class="rounded-md bg-darius-crimson px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                >
                    Delete All
                </button>
            </div>
        </div>
    );
};
