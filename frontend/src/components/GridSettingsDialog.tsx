import { For, Show, createEffect, createSignal } from "solid-js";
import { CanvasGroup } from "../utils/schemas";
import { gridColsOf } from "../utils/gridLayout";
import { Dialog } from "./Dialog";

type GridSettingsDialogProps = {
    group: () => CanvasGroup | null;
    isOpen: () => boolean;
    onCancel: () => void;
    onSave: (settings: {
        gridCols: number;
        rowLabels: string[];
        colLabels: string[];
    }) => void;
    rowCount: (group: CanvasGroup) => number;
};

export const GridSettingsDialog = (props: GridSettingsDialogProps) => {
    const [cols, setCols] = createSignal(3);
    const [rowLabels, setRowLabels] = createSignal<string[]>([]);
    const [colLabels, setColLabels] = createSignal<string[]>([]);

    // Re-seed form state each time the dialog opens for a group.
    createEffect(() => {
        const group = props.group();
        if (!props.isOpen() || !group) return;
        setCols(gridColsOf(group));
        setColLabels(
            Array.from(
                { length: gridColsOf(group) },
                (_, i) => group.metadata.colLabels?.[i] ?? ""
            )
        );
        setRowLabels(
            Array.from(
                { length: props.rowCount(group) },
                (_, i) => group.metadata.rowLabels?.[i] ?? ""
            )
        );
    });

    const handleColsInput = (value: string) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 8) {
            setCols(parsed);
            setColLabels((labels) =>
                Array.from({ length: parsed }, (_, i) => labels[i] ?? "")
            );
        }
    };

    const save = () => {
        props.onSave({
            gridCols: cols(),
            rowLabels: rowLabels().map((l) => l.trim()),
            colLabels: colLabels().map((l) => l.trim())
        });
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onCancel}
            onConfirm={save}
            confirmOnInput
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
                                max="8"
                                value={cols()}
                                onInput={(e) => handleColsInput(e.currentTarget.value)}
                                class="w-20 rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-darius-text-primary"
                            />
                        </label>
                        <div class="flex flex-col gap-1.5">
                            <span class="text-sm text-darius-text-secondary">
                                Column labels
                            </span>
                            <For each={colLabels()}>
                                {(label, i) => (
                                    <input
                                        type="text"
                                        placeholder={`Column ${i() + 1}`}
                                        value={label}
                                        onInput={(e) => {
                                            const next = [...colLabels()];
                                            next[i()] = e.currentTarget.value;
                                            setColLabels(next);
                                        }}
                                        class="rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-sm text-darius-text-primary"
                                    />
                                )}
                            </For>
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <span class="text-sm text-darius-text-secondary">
                                Row labels
                            </span>
                            <For each={rowLabels()}>
                                {(label, i) => (
                                    <input
                                        type="text"
                                        placeholder={`Row ${i() + 1}`}
                                        value={label}
                                        onInput={(e) => {
                                            const next = [...rowLabels()];
                                            next[i()] = e.currentTarget.value;
                                            setRowLabels(next);
                                        }}
                                        class="rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-sm text-darius-text-primary"
                                    />
                                )}
                            </For>
                        </div>
                    </div>
                </Show>
            }
        />
    );
};
