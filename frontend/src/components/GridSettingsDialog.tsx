import { Index, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { gridColsOf, isGridGroup, type GridSettingsInput } from "../utils/gridLayout";
import { Dialog } from "./Dialog";

type GridSettingsDialogProps = {
    group: () => CanvasGroup | null;
    isOpen: () => boolean;
    onCancel: () => void;
    onSave: (settings: GridSettingsInput) => void;
    rowCount: (group: CanvasGroup, cols: number) => number;
};

export const GridSettingsDialog = (props: GridSettingsDialogProps) => {
    const [cols, setCols] = createSignal(3);
    // Seeded from the FULL stored arrays so labels beyond the visible
    // rows/columns are never dropped on save.
    const [rowLabels, setRowLabels] = createSignal<string[]>([]);
    const [colLabels, setColLabels] = createSignal<string[]>([]);

    // Snapshot form state when the dialog opens. Only `props.isOpen()` is
    // tracked; the group/metadata reads are untracked so a socket reconcile
    // from another client while the dialog is open can't re-run this effect and
    // wipe in-progress edits. Re-opens (isOpen false->true) reseed correctly.
    createEffect(() => {
        if (!props.isOpen()) return;
        untrack(() => {
            const group = props.group();
            if (!group) return;
            setCols(gridColsOf(group));
            setColLabels([...(group.metadata.colLabels ?? [])]);
            setRowLabels([...(group.metadata.rowLabels ?? [])]);
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
        return Math.max(props.rowCount(group, cols()), rowLabels().length, 1);
    });

    const handleColsInput = (value: string) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 1) setCols(parsed);
    };

    const setColLabel = (i: number, value: string) => {
        const next = [...colLabels()];
        next[i] = value;
        setColLabels(next);
    };

    const setRowLabel = (i: number, value: string) => {
        const next = [...rowLabels()];
        next[i] = value;
        setRowLabels(next);
    };

    const save = () => {
        // Read signals into locals so the Array.from callbacks below don't read
        // reactive state (keeps solid/reactivity happy; `save` is event-only).
        const colCount = cols();
        const rows = rowLabels();
        const columns = colLabels();
        const rowLen = rowInputCount();
        props.onSave({
            gridCols: colCount,
            rowLabels: Array.from({ length: rowLen }, (_, i) => (rows[i] ?? "").trim()),
            colLabels: Array.from({ length: colCount }, (_, i) =>
                (columns[i] ?? "").trim()
            )
        });
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onCancel}
            onConfirm={save}
            showCloseButton={false}
            body={
                <Show when={props.group()}>
                    <div class="flex flex-col gap-4">
                        <h2 class="text-lg font-semibold text-darius-text-primary">
                            Grid settings
                        </h2>
                        <label class="flex items-center justify-between gap-3 text-sm text-darius-text-secondary">
                            Columns
                            <input
                                type="number"
                                min="1"
                                value={cols()}
                                onInput={(e) => handleColsInput(e.currentTarget.value)}
                                onBlur={(e) => (e.currentTarget.value = String(cols()))}
                                class="w-20 rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-darius-text-primary"
                            />
                        </label>
                        <div class="flex flex-col gap-1.5">
                            <span class="text-sm text-darius-text-secondary">
                                Column labels
                            </span>
                            <Index each={Array.from({ length: cols() })}>
                                {(_, i) => (
                                    <input
                                        type="text"
                                        placeholder={`Column ${i + 1}`}
                                        value={colLabels()[i] ?? ""}
                                        onInput={(e) =>
                                            setColLabel(i, e.currentTarget.value)
                                        }
                                        class="rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-sm text-darius-text-primary"
                                    />
                                )}
                            </Index>
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <span class="text-sm text-darius-text-secondary">
                                Row labels
                            </span>
                            <Index each={Array.from({ length: rowInputCount() })}>
                                {(_, i) => (
                                    <input
                                        type="text"
                                        placeholder={`Row ${i + 1}`}
                                        value={rowLabels()[i] ?? ""}
                                        onInput={(e) =>
                                            setRowLabel(i, e.currentTarget.value)
                                        }
                                        class="rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-sm text-darius-text-primary"
                                    />
                                )}
                            </Index>
                        </div>
                        <div class="flex items-center justify-end gap-2 pt-1">
                            <button
                                type="button"
                                onClick={props.onCancel}
                                class="rounded-md bg-darius-card px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                class="rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors"
                            >
                                {isEditing() ? "Save" : "Arrange"}
                            </button>
                        </div>
                    </div>
                </Show>
            }
        />
    );
};
