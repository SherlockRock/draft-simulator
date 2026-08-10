import { Index, createSignal, type Accessor, type Component } from "solid-js";
import { Minus, Plus } from "lucide-solid";
import type { GridSettingsInput } from "../utils/gridLayout";

/**
 * The columns-and-labels half of grid configuration, shared by the two dialogs
 * that own it (design §10):
 *
 *  - `GridSettingsDialog` — editing an EXISTING Group, reached from the group
 *    context menu's "Arrange as grid…" and "Grid settings…";
 *  - `GroupSettingsDialog` — CREATING a Group, where the same choice has to be
 *    made before the Group exists.
 *
 * Only the form is shared. `GridSettingsDialog` keeps its own shell and both of
 * its entry points: retiring it would mean rehoming two menu call sites for no
 * gain, and an existing grid Group would then have two places to edit the same
 * columns.
 */

export type GridSettingsForm = {
    cols: Accessor<number>;
    colLabels: Accessor<string[]>;
    rowLabels: Accessor<string[]>;
    setCols: (value: number) => void;
    setColLabel: (index: number, value: string) => void;
    setRowLabel: (index: number, value: string) => void;
    /**
     * Snapshot the form from stored metadata (or the new-group defaults) when
     * the dialog opens. Seeded from the FULL stored arrays so labels beyond the
     * currently visible rows/columns are never dropped on save.
     */
    seed: (source: {
        gridCols: number;
        rowLabels?: string[];
        colLabels?: string[];
    }) => void;
    /**
     * The value to persist. `rowInputCount` is however many row inputs were on
     * screen — `mergeLabels` uses it as the count it may overwrite, and a
     * smaller number silently trims stored labels beyond it.
     */
    read: (rowInputCount: number) => GridSettingsInput;
};

export const createGridSettingsForm = (): GridSettingsForm => {
    const [cols, setColsSignal] = createSignal(3);
    const [rowLabels, setRowLabels] = createSignal<string[]>([]);
    const [colLabels, setColLabels] = createSignal<string[]>([]);

    const setColLabel = (index: number, value: string) => {
        const next = [...colLabels()];
        next[index] = value;
        setColLabels(next);
    };

    const setRowLabel = (index: number, value: string) => {
        const next = [...rowLabels()];
        next[index] = value;
        setRowLabels(next);
    };

    return {
        cols,
        colLabels,
        rowLabels,
        setCols: (value: number) => setColsSignal(Math.max(1, value)),
        setColLabel,
        setRowLabel,
        seed: (source) => {
            setColsSignal(source.gridCols);
            setColLabels([...(source.colLabels ?? [])]);
            setRowLabels([...(source.rowLabels ?? [])]);
        },
        read: (rowInputCount: number) => {
            // Read the signals into locals first so the Array.from callbacks
            // below don't read reactive state (keeps solid/reactivity happy;
            // every caller is event-only).
            const colCount = cols();
            const rows = rowLabels();
            const columns = colLabels();
            return {
                gridCols: colCount,
                rowLabels: Array.from({ length: rowInputCount }, (_, i) =>
                    (rows[i] ?? "").trim()
                ),
                colLabels: Array.from({ length: colCount }, (_, i) =>
                    (columns[i] ?? "").trim()
                )
            };
        }
    };
};

const LABEL_INPUT_CLASS =
    "w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 text-sm leading-tight text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright";

const STEPPER_BUTTON_CLASS =
    "flex h-8 w-8 items-center justify-center rounded border border-darius-border bg-darius-card text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-40";

type GridSettingsFieldsProps = {
    form: GridSettingsForm;
    /** How many row-label inputs to offer — see `arrangedRowCount`. */
    rowInputCount: () => number;
    /** Distinguishes the two dialogs' label/input pairs in the document. */
    idPrefix: string;
};

export const GridSettingsFields: Component<GridSettingsFieldsProps> = (props) => {
    const handleColsInput = (value: string) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 1) props.form.setCols(parsed);
    };

    return (
        <div class="space-y-4">
            <div class="flex items-center justify-between gap-3">
                <label
                    class="text-sm font-medium text-darius-text-secondary"
                    for={`${props.idPrefix}-cols`}
                >
                    Columns
                </label>
                <div class="flex items-center gap-1.5">
                    <button
                        type="button"
                        class={STEPPER_BUTTON_CLASS}
                        onClick={() => props.form.setCols(props.form.cols() - 1)}
                        disabled={props.form.cols() <= 1}
                        aria-label="Decrease columns"
                    >
                        <Minus size={14} />
                    </button>
                    <input
                        id={`${props.idPrefix}-cols`}
                        type="number"
                        min="1"
                        value={props.form.cols()}
                        onInput={(e) => handleColsInput(e.currentTarget.value)}
                        onBlur={(e) =>
                            (e.currentTarget.value = String(props.form.cols()))
                        }
                        class="w-14 appearance-none rounded border border-darius-border bg-darius-card px-2 py-1.5 text-center text-sm leading-tight text-darius-text-primary shadow [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-darius-purple-bright [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                        type="button"
                        class={STEPPER_BUTTON_CLASS}
                        onClick={() => props.form.setCols(props.form.cols() + 1)}
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
                    <Index each={Array.from({ length: props.form.cols() })}>
                        {(_, i) => (
                            <input
                                type="text"
                                placeholder={`Column ${i + 1}`}
                                value={props.form.colLabels()[i] ?? ""}
                                onInput={(e) =>
                                    props.form.setColLabel(i, e.currentTarget.value)
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
                    <Index each={Array.from({ length: props.rowInputCount() })}>
                        {(_, i) => (
                            <input
                                type="text"
                                placeholder={`Row ${i + 1}`}
                                value={props.form.rowLabels()[i] ?? ""}
                                onInput={(e) =>
                                    props.form.setRowLabel(i, e.currentTarget.value)
                                }
                                class={LABEL_INPUT_CLASS}
                            />
                        )}
                    </Index>
                </div>
            </div>
        </div>
    );
};
