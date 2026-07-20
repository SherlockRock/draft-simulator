import { Index, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { Minus, Plus } from "lucide-solid";
import { CanvasGroup } from "../utils/schemas";
import { gridColsOf, isGridGroup, type GridSettingsInput } from "../utils/gridLayout";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";

type GridSettingsDialogProps = {
    group: () => CanvasGroup | null;
    isOpen: () => boolean;
    onCancel: () => void;
    onSave: (settings: GridSettingsInput) => void;
    rowCount: (group: CanvasGroup, cols: number) => number;
};

const LABEL_INPUT_CLASS =
    "w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 text-sm leading-tight text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright";

const STEPPER_BUTTON_CLASS =
    "flex h-8 w-8 items-center justify-center rounded border border-darius-border bg-darius-card text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-40";

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

    const stepCols = (delta: number) => setCols((c) => Math.max(1, c + delta));

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
            // Enter inside a label/column field saves and closes, matching
            // CanvasSettingsDialog's convention for text-entry dialogs.
            shouldConfirmOnTarget={(target) => target instanceof HTMLInputElement}
            body={
                <Show when={props.group()}>
                    <div class="flex w-[420px] flex-col text-darius-text-primary">
                        <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                            Grid settings
                        </h2>

                        <div class="space-y-4">
                            <div class="flex items-center justify-between gap-3">
                                <label
                                    class="text-sm font-medium text-darius-text-secondary"
                                    for="grid-settings-cols"
                                >
                                    Columns
                                </label>
                                <div class="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        class={STEPPER_BUTTON_CLASS}
                                        onClick={() => stepCols(-1)}
                                        disabled={cols() <= 1}
                                        aria-label="Decrease columns"
                                    >
                                        <Minus size={14} />
                                    </button>
                                    <input
                                        id="grid-settings-cols"
                                        type="number"
                                        min="1"
                                        value={cols()}
                                        onInput={(e) =>
                                            handleColsInput(e.currentTarget.value)
                                        }
                                        onBlur={(e) =>
                                            (e.currentTarget.value = String(cols()))
                                        }
                                        class="w-14 appearance-none rounded border border-darius-border bg-darius-card px-2 py-1.5 text-center text-sm leading-tight text-darius-text-primary shadow [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-darius-purple-bright [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    />
                                    <button
                                        type="button"
                                        class={STEPPER_BUTTON_CLASS}
                                        onClick={() => stepCols(1)}
                                        aria-label="Increase columns"
                                    >
                                        <Plus size={14} />
                                    </button>
                                </div>
                            </div>

                            <div>
                                <span class="mb-2 block text-sm font-medium text-darius-text-secondary">
                                    Column labels
                                </span>
                                <div class="custom-scrollbar max-h-40 space-y-2 overflow-y-auto pr-1">
                                    <Index each={Array.from({ length: cols() })}>
                                        {(_, i) => (
                                            <input
                                                type="text"
                                                placeholder={`Column ${i + 1}`}
                                                value={colLabels()[i] ?? ""}
                                                onInput={(e) =>
                                                    setColLabel(i, e.currentTarget.value)
                                                }
                                                class={LABEL_INPUT_CLASS}
                                            />
                                        )}
                                    </Index>
                                </div>
                            </div>

                            <div>
                                <span class="mb-2 block text-sm font-medium text-darius-text-secondary">
                                    Row labels
                                </span>
                                <div class="custom-scrollbar max-h-40 space-y-2 overflow-y-auto pr-1">
                                    <Index each={Array.from({ length: rowInputCount() })}>
                                        {(_, i) => (
                                            <input
                                                type="text"
                                                placeholder={`Row ${i + 1}`}
                                                value={rowLabels()[i] ?? ""}
                                                onInput={(e) =>
                                                    setRowLabel(i, e.currentTarget.value)
                                                }
                                                class={LABEL_INPUT_CLASS}
                                            />
                                        )}
                                    </Index>
                                </div>
                            </div>
                        </div>

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
