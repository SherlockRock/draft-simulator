import { Show, createEffect, createMemo, untrack } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { gridColsOf, isGridGroup, type GridSettingsInput } from "../utils/gridLayout";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";
import { GridSettingsFields, createGridSettingsForm } from "./GridSettingsFields";

type GridSettingsDialogProps = {
    group: () => CanvasGroup | null;
    isOpen: () => boolean;
    onCancel: () => void;
    onSave: (settings: GridSettingsInput) => void;
    rowCount: (group: CanvasGroup, cols: number) => number;
};

export const GridSettingsDialog = (props: GridSettingsDialogProps) => {
    const form = createGridSettingsForm();

    // Snapshot form state when the dialog opens. Only `props.isOpen()` is
    // tracked; the group/metadata reads are untracked so a socket reconcile
    // from another client while the dialog is open can't re-run this effect and
    // wipe in-progress edits. Re-opens (isOpen false->true) reseed correctly.
    createEffect(() => {
        if (!props.isOpen()) return;
        untrack(() => {
            const group = props.group();
            if (!group) return;
            form.seed({
                gridCols: gridColsOf(group),
                colLabels: group.metadata.colLabels,
                rowLabels: group.metadata.rowLabels
            });
        });
    });

    const isEditing = createMemo(() => {
        const group = props.group();
        return group ? isGridGroup(group) : false;
    });

    // Row inputs: enough to cover the rows a reflow will produce AND any stored
    // labels, so growth is reachable and nothing truncates. Reacts to cols().
    const rowInputCount = createMemo(() => {
        const group = props.group();
        if (!group) return 0;
        return Math.max(props.rowCount(group, form.cols()), form.rowLabels().length, 1);
    });

    const save = () => props.onSave(form.read(rowInputCount()));

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onCancel}
            onConfirm={save}
            // Enter inside a label/column field saves and closes, matching
            // CanvasSettingsDialog's convention for text-entry dialogs.
            shouldConfirmOnTarget={(target) => target instanceof HTMLInputElement}
            body={
                <Show when={props.group()}>
                    <div class="flex w-[420px] flex-col text-darius-text-primary">
                        <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                            Grid settings
                        </h2>

                        <GridSettingsFields
                            form={form}
                            rowInputCount={rowInputCount}
                            idPrefix="grid-settings"
                        />

                        <div class="mt-6 flex items-center justify-end gap-2 border-t border-darius-border pt-4">
                            <button
                                type="button"
                                onClick={props.onCancel}
                                class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                            >
                                <span>Cancel</span>
                                <EscapeKeyHint />
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                class="flex items-center gap-2 rounded-md bg-darius-purple px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-purple-bright"
                            >
                                <span>{isEditing() ? "Save" : "Arrange"}</span>
                                <ReturnKeyHint />
                            </button>
                        </div>
                    </div>
                </Show>
            }
        />
    );
};
