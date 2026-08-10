import { Index, createSignal, type Accessor, type Component } from "solid-js";
import { Minus, Plus } from "lucide-solid";
import { DEFAULT_GRID_COLS, DEFAULT_GRID_ROWS } from "../utils/gridLayout";
import type { GridSettingsInput } from "../utils/gridLayout";

/**
 * The grid half of `GroupSettingsDialog` — columns, rows and their labels.
 *
 * A separate module rather than more markup in a dialog that is already long,
 * and because the form's state (`createGridSettingsForm`) is worth having as
 * one testable object rather than five signals threaded through props.
 *
 * Rows are a stored setting, not a derived count: `metadata.gridRows` is the
 * MINIMUM number of rows the container presents, so a Group built as a 3x4 grid
 * opens as one while empty. Content needing more rows still gets them.
 */

export type GridSettingsForm = {
    cols: Accessor<number>;
    rows: Accessor<number>;
    colLabels: Accessor<string[]>;
    rowLabels: Accessor<string[]>;
    setCols: (value: number) => void;
    setRows: (value: number) => void;
    setColLabel: (index: number, value: string) => void;
    setRowLabel: (index: number, value: string) => void;
    /**
     * Snapshot the form from stored metadata (or the new-group defaults) when
     * the dialog opens. Seeded from the FULL stored arrays so labels beyond the
     * currently visible rows/columns are never dropped on save.
     */
    seed: (source: {
        gridCols?: number;
        gridRows?: number;
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
    const [cols, setColsSignal] = createSignal(DEFAULT_GRID_COLS);
    const [rows, setRowsSignal] = createSignal(DEFAULT_GRID_ROWS);
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
        rows,
        colLabels,
        rowLabels,
        setCols: (value: number) => setColsSignal(Math.max(1, value)),
        setRows: (value: number) => setRowsSignal(Math.max(1, value)),
        setColLabel,
        setRowLabel,
        seed: (source) => {
            setColsSignal(source.gridCols ?? DEFAULT_GRID_COLS);
            setRowsSignal(source.gridRows ?? DEFAULT_GRID_ROWS);
            setColLabels([...(source.colLabels ?? [])]);
            setRowLabels([...(source.rowLabels ?? [])]);
        },
        read: (rowInputCount: number) => {
            // Read the signals into locals first so the Array.from callbacks
            // below don't read reactive state (keeps solid/reactivity happy;
            // every caller is event-only).
            const colCount = cols();
            const rowCount = rows();
            const rowNames = rowLabels();
            const columns = colLabels();
            return {
                gridCols: colCount,
                gridRows: rowCount,
                rowLabels: Array.from({ length: rowInputCount }, (_, i) =>
                    (rowNames[i] ?? "").trim()
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

const NUMBER_INPUT_CLASS =
    "w-14 appearance-none rounded border border-darius-border bg-darius-card px-2 py-1.5 text-center text-sm leading-tight text-darius-text-primary shadow [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-darius-purple-bright [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

type CountStepperProps = {
    id: string;
    label: string;
    value: () => number;
    onChange: (value: number) => void;
};

const CountStepper: Component<CountStepperProps> = (props) => {
    const handleInput = (raw: string) => {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed >= 1) props.onChange(parsed);
    };

    return (
        <div class="flex items-center justify-between gap-3">
            <label class="text-sm font-medium text-darius-text-secondary" for={props.id}>
                {props.label}
            </label>
            <div class="flex items-center gap-1.5">
                <button
                    type="button"
                    class={STEPPER_BUTTON_CLASS}
                    onClick={() => props.onChange(props.value() - 1)}
                    disabled={props.value() <= 1}
                    aria-label={`Decrease ${props.label.toLowerCase()}`}
                >
                    <Minus size={14} />
                </button>
                <input
                    id={props.id}
                    type="number"
                    min="1"
                    value={props.value()}
                    onInput={(e) => handleInput(e.currentTarget.value)}
                    onBlur={(e) => (e.currentTarget.value = String(props.value()))}
                    class={NUMBER_INPUT_CLASS}
                />
                <button
                    type="button"
                    class={STEPPER_BUTTON_CLASS}
                    onClick={() => props.onChange(props.value() + 1)}
                    aria-label={`Increase ${props.label.toLowerCase()}`}
                >
                    <Plus size={14} />
                </button>
            </div>
        </div>
    );
};

type GridSettingsFieldsProps = {
    form: GridSettingsForm;
    /**
     * How many row-label inputs to offer: at least the configured row count,
     * and at least as many as the container's content already occupies.
     */
    rowInputCount: () => number;
    /** Distinguishes the two field groups' label/input pairs in the document. */
    idPrefix: string;
};

export const GridSettingsFields: Component<GridSettingsFieldsProps> = (props) => (
    <div class="space-y-4">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CountStepper
                id={`${props.idPrefix}-cols`}
                label="Columns"
                value={props.form.cols}
                onChange={props.form.setCols}
            />
            <CountStepper
                id={`${props.idPrefix}-rows`}
                label="Rows"
                value={props.form.rows}
                onChange={props.form.setRows}
            />
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
