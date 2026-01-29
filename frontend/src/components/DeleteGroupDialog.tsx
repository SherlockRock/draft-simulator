import { CanvasGroup } from "../utils/types";

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
            <h3 class="mb-4 text-lg font-bold text-slate-50">
                Delete group "{props.group.name}"?
            </h3>
            <p class="mb-6 text-slate-200">
                This group contains {props.draftCount} draft{props.draftCount !== 1 ? "s" : ""}.
            </p>
            <div class="flex justify-end gap-3">
                <button
                    onClick={props.onCancel}
                    class="rounded-md bg-slate-600 px-4 py-2 text-slate-200 hover:bg-slate-500"
                >
                    Cancel
                </button>
                <button
                    onClick={props.onKeepDrafts}
                    class="rounded-md bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
                >
                    Keep Drafts
                </button>
                <button
                    onClick={props.onDeleteAll}
                    class="rounded-md bg-red-500 px-4 py-2 text-slate-50 hover:bg-red-600"
                >
                    Delete All
                </button>
            </div>
        </div>
    );
};
