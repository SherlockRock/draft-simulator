import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup
} from "solid-js";
import { X } from "lucide-solid";
import { Dialog } from "./Dialog";
import { FilterBar } from "./FilterBar";
import { RoleFilter } from "./RoleFilter";
import { useMultiFilterableItems } from "../hooks/useFilterableItems";
import { champions, championCategories } from "../utils/constants";

export type ChampionColorState =
    | "picked"
    | "own-team"
    | "other-team"
    | "shared"
    | "neutral";

export interface ChampionPickerProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (championId: string) => void;

    contextLabel?: string;
    actionVerb?: string;
    disabledChampionIds?: Set<string>;
    championColoring?: (championId: string) => ChampionColorState;
    initialRole?: "all" | "Top" | "Jungle" | "Mid" | "Bot" | "Support";
}

const GRID_COLS = 5;

function borderClassFor(
    state: ChampionColorState,
    disabled: boolean,
    highlighted: boolean
): string {
    if (disabled) return "border-slate-700 opacity-30 cursor-not-allowed";
    if (highlighted) return "border-darius-crimson ring-2 ring-darius-crimson/40";
    switch (state) {
        case "picked":
            return "border-slate-700 opacity-30 cursor-not-allowed";
        case "own-team":
            return "border-blue-400";
        case "other-team":
            return "border-red-400/60";
        case "shared":
            return "border-purple-400";
        case "neutral":
        default:
            return "border-darius-border hover:border-darius-purple-bright";
    }
}

const ChampionPicker: Component<ChampionPickerProps> = (props) => {
    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
    const [highlightedIndex, setHighlightedIndex] = createSignal(0);
    let gridRef: HTMLDivElement | undefined;

    // Reset highlight to 0 whenever the filtered list changes.
    createEffect(() => {
        filterState.filteredItems();
        setHighlightedIndex(0);
    });

    // Scroll highlighted tile into view on change.
    createEffect(() => {
        const idx = highlightedIndex();
        if (!gridRef) return;
        const tile = gridRef.querySelector<HTMLButtonElement>(`[data-grid-idx="${idx}"]`);
        tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    const highlightedChampion = createMemo(() => {
        const items = filterState.filteredItems();
        return items[highlightedIndex()]?.item ?? null;
    });

    const exactChampionMatch = createMemo(() => {
        const normalized = filterState.searchText().trim().toLowerCase();
        if (!normalized) return null;
        return (
            champions.find(
                (champion) => champion.name.trim().toLowerCase() === normalized
            ) ?? null
        );
    });

    let searchInputRef: HTMLInputElement | undefined;

    // Apply initialRole once per open.
    createEffect(() => {
        if (!props.isOpen) return;
        filterState.setSearchText("");
        filterState.clearCategories();
        const initial = props.initialRole;
        if (initial && initial !== "all") {
            filterState.toggleCategory(initial);
        }
        queueMicrotask(() => searchInputRef?.focus());
    });

    createEffect(() => {
        if (!props.isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            // Escape is handled by the shared Dialog wrapper.
            const items = filterState.filteredItems();
            if (items.length === 0) return;

            if (e.key === "ArrowRight") {
                e.preventDefault();
                setHighlightedIndex((i) => Math.min(i + 1, items.length - 1));
                return;
            }
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                setHighlightedIndex((i) => Math.max(i - 1, 0));
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightedIndex((i) => Math.min(i + GRID_COLS, items.length - 1));
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightedIndex((i) => Math.max(i - GRID_COLS, 0));
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                const champ = exactChampionMatch() ?? items[highlightedIndex()]?.item;
                if (!champ) return;
                if (props.disabledChampionIds?.has(champ.id)) return;
                props.onSelect(champ.id);
            }

            // Auto-focus search for alphanumeric keys when search isn't focused.
            if (
                e.key.length === 1 &&
                /^[a-zA-Z0-9 ]$/.test(e.key) &&
                document.activeElement !== searchInputRef
            ) {
                searchInputRef?.focus();
                // Do not preventDefault — let the character land in the input.
            }
        };
        window.addEventListener("keydown", handleKey);
        onCleanup(() => window.removeEventListener("keydown", handleKey));
    });

    const actionVerb = createMemo(() => props.actionVerb ?? "Pick");

    return (
        <Show when={props.isOpen}>
            <Dialog
                isOpen={() => props.isOpen}
                onCancel={props.onClose}
                showCloseButton={false}
                contentClass="relative flex w-full max-w-sm flex-col overflow-hidden rounded-lg border border-darius-border bg-darius-card shadow-xl"
                body={
                    <>
                        <button
                            type="button"
                            onClick={() => props.onClose()}
                            class="absolute right-3 top-3 z-10 text-darius-text-secondary hover:text-darius-text-primary"
                            aria-label="Close champion picker"
                        >
                            <X size={18} />
                        </button>

                        {/* Search */}
                        <div class="border-b border-darius-border/60 px-3 pb-2 pt-3">
                            <FilterBar
                                searchText={filterState.searchText}
                                onSearchChange={filterState.setSearchText}
                                searchPlaceholder="Search champions..."
                                inputRef={(el) => (searchInputRef = el)}
                            />
                        </div>

                        {/* Role filter */}
                        <div class="border-b border-darius-border/60 px-3 py-2">
                            <RoleFilter
                                categories={filterState.categories}
                                selectedCategories={filterState.selectedCategories}
                                onToggle={filterState.toggleCategory}
                                onClearAll={filterState.clearCategories}
                                theme="neutral"
                            />
                        </div>

                        {/* Grid */}
                        <div class="custom-scrollbar max-h-[360px] overflow-y-auto px-3 py-3">
                            <div
                                ref={gridRef}
                                class={`grid grid-cols-${GRID_COLS} gap-1.5`}
                            >
                                <For each={filterState.filteredItems()}>
                                    {({ item: champion }, index) => {
                                        const state = () =>
                                            props.championColoring?.(champion.id) ??
                                            "neutral";
                                        const disabled = () =>
                                            props.disabledChampionIds?.has(champion.id) ??
                                            false;
                                        const highlighted = () =>
                                            highlightedIndex() === index();
                                        return (
                                            <button
                                                type="button"
                                                data-grid-idx={index()}
                                                onClick={() => {
                                                    if (disabled()) return;
                                                    props.onSelect(champion.id);
                                                }}
                                                onMouseEnter={() =>
                                                    setHighlightedIndex(index())
                                                }
                                                disabled={disabled()}
                                                title={champion.name}
                                                class={`relative aspect-square overflow-hidden rounded border-2 transition-all ${borderClassFor(
                                                    state(),
                                                    disabled(),
                                                    highlighted()
                                                )}`}
                                            >
                                                <img
                                                    src={champion.img}
                                                    alt={champion.name}
                                                    draggable={false}
                                                    class="h-full w-full object-cover"
                                                />
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>

                        {/* Footer */}
                        <div class="border-t border-darius-border/60 px-3 py-2">
                            <Show when={props.contextLabel}>
                                <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-darius-text-secondary">
                                    {props.contextLabel}
                                </div>
                            </Show>
                            <div class="mt-1 flex items-center justify-between text-xs">
                                <span class="text-darius-text-secondary">
                                    <kbd class="rounded border border-darius-border px-1 py-[1px] text-[10px] font-semibold text-darius-text-primary">
                                        ENTER
                                    </kbd>{" "}
                                    <span>
                                        {actionVerb()}{" "}
                                        <span class="text-darius-text-primary">
                                            {highlightedChampion()?.name ?? "—"}
                                        </span>
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => props.onClose()}
                                    class="text-xs font-semibold uppercase tracking-wider text-darius-crimson hover:text-darius-crimson/80"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </>
                }
            />
        </Show>
    );
};

export default ChampionPicker;
