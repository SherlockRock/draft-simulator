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

/**
 * The editor is a miniature of the grid itself (design option B, 2026-11-10):
 * column labels across the top, row labels down the left, one cell per slot,
 * and the + / − for each axis on the edge that axis grows from.
 *
 * ⚠️ The board is a FIXED size. The dialog is centred vertically, so anything
 * that grew with the counts re-centred the dialog and slid the buttons out from
 * under the cursor — a second click on "+" missed. Cells shrink to fit instead,
 * down to a floor, after which the lattice scrolls inside the board; the edge
 * buttons sit outside the scroll region and never move.
 *
 * Headers and cells share ONE CSS grid inside one scroll container, so a label
 * cannot drift out of line with its column or row however far it scrolls; the
 * label row and column are sticky.
 */
const BOARD_CLASS =
    "grid h-64 grid-cols-[minmax(0,1fr)_2.25rem] grid-rows-[minmax(0,1fr)_2.25rem] gap-1.5";

const LATTICE_SCROLL_CLASS =
    "custom-scrollbar overflow-auto rounded-md bg-darius-bg p-1 shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)]";

const HEADER_INPUT_CLASS =
    "h-full w-full min-w-0 appearance-none rounded border border-darius-border bg-darius-card px-1.5 text-xs text-darius-text-primary placeholder:text-darius-text-secondary/60 focus:border-darius-purple-bright focus:outline-none focus:ring-1 focus:ring-darius-purple-bright";

const CELL_CLASS =
    "rounded border border-darius-border bg-gradient-to-b from-darius-card-hover to-darius-card shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

/**
 * A row the container's content occupies beyond the configured count. Shown so
 * the board matches the group, but dashed: "−" cannot remove it while drafts
 * sit there.
 */
const OVERFLOW_CELL_CLASS = "rounded border border-dashed border-darius-border";

const EDGE_BUTTON_CLASS =
    "flex items-center justify-center rounded-md border border-dashed border-darius-purple-bright/40 bg-darius-purple-bright/5 text-darius-purple-bright transition-colors hover:border-solid hover:border-darius-purple-bright hover:bg-darius-purple-bright/20 disabled:cursor-not-allowed disabled:opacity-30";

const EDGE_ADD_CLASS = `${EDGE_BUTTON_CLASS} flex-1`;
const EDGE_REMOVE_CLASS = `${EDGE_BUTTON_CLASS} basis-[30%] text-darius-text-secondary`;

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

export const GridSettingsFields: Component<GridSettingsFieldsProps> = (props) => {
    const latticeStyle = () => ({
        "grid-template-columns": `5.25rem repeat(${props.form.cols()}, minmax(3.25rem, 1fr))`,
        "grid-template-rows": `2.25rem repeat(${props.rowInputCount()}, minmax(1.75rem, 1fr))`
    });

    return (
        <div class="space-y-2">
            <div class="flex items-center justify-between">
                <span
                    id={`${props.idPrefix}-heading`}
                    class="text-xs font-bold uppercase tracking-wider text-darius-text-secondary"
                >
                    Layout
                </span>
                <span class="rounded-full border border-darius-purple-bright/45 bg-darius-purple-bright/15 px-2.5 py-0.5 font-mono text-xs font-bold text-darius-text-primary">
                    {props.form.cols()} × {props.form.rows()}
                </span>
            </div>

            <div
                class={BOARD_CLASS}
                role="group"
                aria-labelledby={`${props.idPrefix}-heading`}
            >
                <div class={LATTICE_SCROLL_CLASS}>
                    <div class="grid min-h-full min-w-full gap-1" style={latticeStyle()}>
                        <div class="sticky left-0 top-0 z-20 bg-darius-bg" />
                        <Index each={Array.from({ length: props.form.cols() })}>
                            {(_, c) => (
                                <div class="sticky top-0 z-10 bg-darius-bg">
                                    <input
                                        type="text"
                                        placeholder={`Col ${c + 1}`}
                                        aria-label={`Column ${c + 1} label`}
                                        value={props.form.colLabels()[c] ?? ""}
                                        onInput={(e) =>
                                            props.form.setColLabel(
                                                c,
                                                e.currentTarget.value
                                            )
                                        }
                                        class={`${HEADER_INPUT_CLASS} text-center`}
                                    />
                                </div>
                            )}
                        </Index>
                        <Index each={Array.from({ length: props.rowInputCount() })}>
                            {(_, r) => (
                                <>
                                    <div class="sticky left-0 z-10 bg-darius-bg">
                                        <input
                                            type="text"
                                            placeholder={`Row ${r + 1}`}
                                            aria-label={`Row ${r + 1} label`}
                                            value={props.form.rowLabels()[r] ?? ""}
                                            onInput={(e) =>
                                                props.form.setRowLabel(
                                                    r,
                                                    e.currentTarget.value
                                                )
                                            }
                                            class={HEADER_INPUT_CLASS}
                                        />
                                    </div>
                                    <Index
                                        each={Array.from({ length: props.form.cols() })}
                                    >
                                        {() => (
                                            <div
                                                class={
                                                    r < props.form.rows()
                                                        ? CELL_CLASS
                                                        : OVERFLOW_CELL_CLASS
                                                }
                                                title={
                                                    r < props.form.rows()
                                                        ? undefined
                                                        : "Kept by drafts already in this row"
                                                }
                                            />
                                        )}
                                    </Index>
                                </>
                            )}
                        </Index>
                    </div>
                </div>

                <div class="flex flex-col gap-1">
                    <button
                        type="button"
                        class={EDGE_ADD_CLASS}
                        onClick={() => props.form.setCols(props.form.cols() + 1)}
                        aria-label="Add column"
                        title="Add column"
                    >
                        <Plus size={14} />
                    </button>
                    <button
                        type="button"
                        class={EDGE_REMOVE_CLASS}
                        onClick={() => props.form.setCols(props.form.cols() - 1)}
                        disabled={props.form.cols() <= 1}
                        aria-label="Remove column"
                        title="Remove column"
                    >
                        <Minus size={14} />
                    </button>
                </div>

                <div class="flex gap-1">
                    <button
                        type="button"
                        class={EDGE_ADD_CLASS}
                        onClick={() => props.form.setRows(props.form.rows() + 1)}
                        aria-label="Add row"
                        title="Add row"
                    >
                        <Plus size={14} />
                    </button>
                    <button
                        type="button"
                        class={EDGE_REMOVE_CLASS}
                        onClick={() => props.form.setRows(props.form.rows() - 1)}
                        disabled={props.form.rows() <= 1}
                        aria-label="Remove row"
                        title="Remove row"
                    >
                        <Minus size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
};
