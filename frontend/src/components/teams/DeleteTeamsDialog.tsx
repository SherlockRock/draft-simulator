import { Component, Show } from "solid-js";
import type { ManagedTeamRow } from "@draft-sim/shared-types";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "../Dialog";
import { deleteConfirmText } from "../../utils/teamsPage";

// Open while `rows` is non-empty. Single-row and bulk deletes both land here.
export const DeleteTeamsDialog: Component<{
    rows: ManagedTeamRow[];
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}> = (props) => {
    const confirm = () => {
        if (!props.pending && props.rows.length > 0) props.onConfirm();
    };
    return (
        <Dialog
            isOpen={() => props.rows.length > 0}
            onCancel={() => props.onCancel()}
            onConfirm={confirm}
            body={
                <Show when={props.rows.length > 0}>
                    <div class="w-[min(100vw-2rem,24rem)] max-w-full">
                        <h2 class="mb-3 text-lg font-bold text-darius-text-primary">
                            {props.rows.length === 1 ? "Delete team" : "Delete teams"}
                        </h2>
                        <p class="mb-5 text-sm text-darius-text-secondary">
                            {deleteConfirmText(props.rows)}
                        </p>
                        <div class="flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => props.onCancel()}
                                class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                            >
                                <span>Cancel</span>
                                <EscapeKeyHint />
                            </button>
                            <button
                                type="button"
                                onClick={confirm}
                                disabled={props.pending}
                                class="flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-red-500 disabled:opacity-50"
                            >
                                <span>Delete</span>
                                <ReturnKeyHint />
                            </button>
                        </div>
                    </div>
                </Show>
            }
        />
    );
};
