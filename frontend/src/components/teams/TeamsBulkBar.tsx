import { Component, Show } from "solid-js";
import { selectionBarLabel, type SelectionSummary } from "../../utils/teamsPage";

// Fixed to the bottom of the window while rows are selected.
export const TeamsBulkBar: Component<{
    summary: SelectionSummary;
    pending: boolean;
    onArchive: () => void;
    onRestore: () => void;
    onDelete: () => void;
    onClear: () => void;
}> = (props) => (
    <div class="fixed inset-x-0 bottom-0 z-40 border-t border-darius-border bg-darius-card px-4 py-3 shadow-lg">
        <div class="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2">
            <span class="text-sm text-darius-text-primary">
                {selectionBarLabel(props.summary)}
            </span>
            <div class="ml-auto flex flex-wrap items-center gap-2">
                <Show when={props.summary.canArchive}>
                    <button
                        type="button"
                        onClick={() => props.onArchive()}
                        disabled={props.pending}
                        class="rounded-md bg-darius-ember px-3 py-1.5 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110 disabled:opacity-50"
                    >
                        Archive
                    </button>
                </Show>
                <Show when={props.summary.canRestore}>
                    <button
                        type="button"
                        onClick={() => props.onRestore()}
                        disabled={props.pending}
                        class="rounded-md bg-darius-ember px-3 py-1.5 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110 disabled:opacity-50"
                    >
                        Restore
                    </button>
                </Show>
                <Show when={props.summary.canDelete}>
                    <button
                        type="button"
                        onClick={() => props.onDelete()}
                        disabled={props.pending}
                        class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-darius-text-primary transition-colors hover:bg-red-500 disabled:opacity-50"
                    >
                        Delete
                    </button>
                </Show>
                <button
                    type="button"
                    onClick={() => props.onClear()}
                    class="rounded-md border border-darius-border bg-darius-card-hover px-3 py-1.5 text-sm text-darius-text-secondary transition-colors hover:bg-darius-border"
                >
                    Clear
                </button>
            </div>
        </div>
    </div>
);
