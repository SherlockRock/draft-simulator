import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup
} from "solid-js";
import {
    cycleIndex,
    filterPaletteCommands,
    type PaletteCommand,
    type PaletteCommandId
} from "../../utils/navigatorPalette";

export interface NavigatorCommandPaletteProps {
    open: boolean;
    heading: string;
    commands: PaletteCommand[];
    preview: (id: PaletteCommandId) => string[];
    canvases: { id: string; name: string }[];
    canvasesLoading: boolean;
    defaultCanvasId: string | null;
    onRun: (id: PaletteCommandId) => void;
    onExport: (canvasId: string) => void;
    onClose: () => void;
}

type Stage = "commands" | "canvas";

/** Design § 6, model C: search on top, commands left, live pane right. */
export const NavigatorCommandPalette: Component<NavigatorCommandPaletteProps> = (
    props
) => {
    const [query, setQuery] = createSignal("");
    const [stage, setStage] = createSignal<Stage>("commands");
    const [active, setActive] = createSignal<PaletteCommand | null>(null);
    const [highlight, setHighlight] = createSignal(0);
    const [rightHighlight, setRightHighlight] = createSignal(0);
    let inputEl: HTMLInputElement | undefined;

    const reset = () => {
        setQuery("");
        setStage("commands");
        setActive(null);
        setHighlight(0);
        setRightHighlight(0);
    };
    createEffect(
        on(
            () => props.open,
            (open) => {
                reset();
                if (open) queueMicrotask(() => inputEl?.focus());
            }
        )
    );

    const filtered = createMemo(() =>
        filterPaletteCommands(props.commands, stage() === "commands" ? query() : "")
    );
    // Reset the highlight when the VISIBLE set changes, not when the parent
    // rebuilds the same commands (every snapshot/selection does).
    createEffect(
        on(
            () =>
                filtered()
                    .map((c) => c.id)
                    .join("|"),
            () => setHighlight(0)
        )
    );
    const highlighted = createMemo(() => filtered()[highlight()] ?? null);
    const canvasRows = createMemo(() => {
        const q = query().trim().toLowerCase();
        return props.canvases.filter((c) => q === "" || c.name.toLowerCase().includes(q));
    });
    createEffect(
        on([stage, canvasRows], () => {
            if (stage() !== "canvas") return;
            const idx = canvasRows().findIndex((c) => c.id === props.defaultCanvasId);
            setRightHighlight(idx >= 0 ? idx : 0);
        })
    );

    const heading = createMemo(() =>
        stage() === "canvas" ? "Export selected line to canvas" : props.heading
    );

    const run = (cmd: PaletteCommand) => {
        if (cmd.disabledReason !== null) return;
        if (cmd.opensPane === "canvas") {
            setActive(cmd);
            setStage("canvas");
            setQuery("");
            queueMicrotask(() => inputEl?.focus());
            return;
        }
        props.onRun(cmd.id);
    };
    const back = () => {
        setStage("commands");
        setActive(null);
        setQuery("");
    };

    const onKey = (e: KeyboardEvent) => {
        // Defence in depth only: the real guarantee that no modal coexists with an
        // open palette is `canOpenPalette` in NavigatorDrafting (plus the z-40 overlay).
        if (!props.open || e.defaultPrevented) return;
        if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
            return;
        }
        if (stage() !== "commands" && e.key === "Backspace" && query() === "") {
            e.preventDefault();
            back();
            return;
        }
        if (stage() === "canvas") {
            const n = canvasRows().length;
            if (e.key === "ArrowDown") setRightHighlight((h) => cycleIndex(h, 1, n));
            else if (e.key === "ArrowUp") setRightHighlight((h) => cycleIndex(h, -1, n));
            else if (e.key === "Enter") {
                const row = canvasRows()[rightHighlight()];
                if (row) props.onExport(row.id);
            } else return;
            e.preventDefault();
            return;
        }
        const cmd = highlighted();
        const n = filtered().length;
        if (e.key === "ArrowDown") setHighlight((h) => cycleIndex(h, 1, n));
        else if (e.key === "ArrowUp") setHighlight((h) => cycleIndex(h, -1, n));
        else if (e.key === "Enter") {
            if (cmd) run(cmd);
        } else return;
        e.preventDefault();
    };
    createEffect(() => {
        if (!props.open) return;
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    const placeholder = () =>
        stage() === "canvas"
            ? "Type a canvas name…"
            : "Type a command… (enter to run, › to open)";

    return (
        <Show when={props.open}>
            <div class="fixed inset-0 z-40" onClick={() => props.onClose()} />
            <div
                data-palette
                data-palette-mode="centred"
                class="fixed left-1/2 top-24 z-50 w-[720px] -translate-x-1/2 rounded-xl border border-sky-300/70 bg-darius-card p-3 shadow-2xl shadow-black/70"
                onClick={(e) => e.stopPropagation()}
            >
                <div class="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider">
                    <span data-palette-heading class="text-sky-300">
                        {heading()}
                    </span>
                    <span class="text-slate-500">
                        {stage() === "commands" ? "↑↓ enter · esc" : "backspace · esc"}
                    </span>
                </div>
                <input
                    data-palette-input
                    ref={(el) => (inputEl = el)}
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    placeholder={placeholder()}
                    class="mb-2 w-full rounded-md border border-darius-border bg-darius-bg px-2 py-1.5 text-sm text-slate-50 outline-none focus:border-sky-300"
                />
                <div class="grid grid-cols-[240px_1fr] gap-3">
                    <div class="border-r border-darius-border/60 pr-3">
                        <For
                            each={
                                stage() === "commands"
                                    ? filtered()
                                    : props.commands.filter((c) => c.id === active()?.id)
                            }
                        >
                            {(cmd, i) => {
                                const isHighlighted = () =>
                                    stage() === "commands" && highlight() === i();
                                return (
                                    <button
                                        type="button"
                                        data-palette-command={cmd.id}
                                        data-highlighted={
                                            isHighlighted() ? "true" : "false"
                                        }
                                        aria-disabled={
                                            cmd.disabledReason !== null ? "true" : "false"
                                        }
                                        title={cmd.disabledReason ?? undefined}
                                        onMouseEnter={() =>
                                            stage() === "commands" && setHighlight(i())
                                        }
                                        onClick={() => run(cmd)}
                                        class={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${cmd.disabledReason !== null ? "text-slate-500" : isHighlighted() ? "bg-slate-700/70 text-slate-50" : "text-slate-200 hover:bg-slate-800"}`}
                                    >
                                        <span>
                                            {cmd.label}
                                            <Show when={cmd.opensPane !== null}>
                                                <span class="ml-1 text-slate-500">›</span>
                                            </Show>
                                        </span>
                                        <span class="text-[11px] text-slate-500">
                                            {cmd.disabledReason ?? cmd.hint ?? ""}
                                        </span>
                                    </button>
                                );
                            }}
                        </For>
                        <Show when={stage() === "commands" && filtered().length === 0}>
                            <div class="px-2 py-2 text-xs text-slate-500">
                                No matching command
                            </div>
                        </Show>
                    </div>
                    <div class="min-h-[200px]">
                        <Show when={stage() === "canvas"}>
                            <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-400">
                                Choose a canvas · enter to export
                            </div>
                            <Show when={props.canvasesLoading}>
                                <div class="text-xs text-slate-500">
                                    Loading canvases…
                                </div>
                            </Show>
                            <Show
                                when={!props.canvasesLoading && canvasRows().length === 0}
                            >
                                <div class="text-xs text-slate-500">No canvas found</div>
                            </Show>
                            <For each={canvasRows()}>
                                {(c, i) => (
                                    <button
                                        type="button"
                                        data-canvas-row={c.id}
                                        data-highlighted={
                                            rightHighlight() === i() ? "true" : "false"
                                        }
                                        onMouseEnter={() => setRightHighlight(i())}
                                        onClick={() => props.onExport(c.id)}
                                        class={`flex w-full items-center rounded px-2 py-1 text-left text-sm ${rightHighlight() === i() ? "bg-slate-700/70 text-slate-50" : "text-slate-200 hover:bg-slate-800"}`}
                                    >
                                        {c.name}
                                    </button>
                                )}
                            </For>
                        </Show>
                        <Show when={stage() === "commands"}>
                            <Show when={highlighted() !== null}>
                                <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-400">
                                    Preview
                                </div>
                                <For
                                    each={
                                        highlighted()
                                            ? props.preview(highlighted()?.id ?? "clear")
                                            : []
                                    }
                                >
                                    {(line) => (
                                        <div class="text-sm text-slate-300">{line}</div>
                                    )}
                                </For>
                            </Show>
                        </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
};
