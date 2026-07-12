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
import { X } from "lucide-solid";
import { FilterBar } from "./FilterBar";
import { RoleFilter } from "./RoleFilter";
import { useMultiFilterableItems } from "../hooks/useFilterableItems";
import { champions, championCategories } from "../utils/constants";
import { resolveEnterAction, type EnterAction } from "../utils/championPickerEnter";

const GRID_COLS = 5;

export interface ChampionPickerCoreProps {
    /** Commit an available champion (tile click or Enter). reverse = Shift held. */
    onPick: (championId: string, reverse: boolean) => void;
    /** Advance mode: Enter resolved to nothing committable. Omit outside advance mode. */
    onSkip?: (reverse: boolean) => void;
    /** Advance mode: Tab/Shift+Tab moves the target. Omit to leave Tab alone. */
    onTab?: (reverse: boolean) => void;
    onClose: () => void;
    isAvailable: (championId: string) => boolean;
    contextLabel: string;
    /** Changes when the advance target moves: clears search and refocuses it. */
    targetKey: string;
}

export const ChampionPickerCore: Component<ChampionPickerCoreProps> = (props) => {
    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
    const [highlightedIndex, setHighlightedIndex] = createSignal(0);
    // Arrow keys arm the highlight for Enter; any filter change disarms so
    // stale arming can never commit an unseen champion (design D2).
    const [armed, setArmed] = createSignal(false);
    let gridRef: HTMLDivElement | undefined;
    let searchInputRef: HTMLInputElement | undefined;

    createEffect(() => {
        filterState.filteredItems();
        setHighlightedIndex(0);
        setArmed(false);
    });

    createEffect(() => {
        const idx = highlightedIndex();
        if (!gridRef) return;
        const tile = gridRef.querySelector(`[data-grid-idx="${idx}"]`);
        tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    const highlightedChampion = createMemo(
        () => filterState.filteredItems()[highlightedIndex()]?.item ?? null
    );

    const enterAction = createMemo<EnterAction>(() =>
        resolveEnterAction({
            searchText: filterState.searchText(),
            filteredItems: filterState
                .filteredItems()
                .map(({ item }) => ({ id: item.id, name: item.name })),
            allChampions: champions,
            armed: armed(),
            highlightedItem: highlightedChampion(),
            isAvailable: props.isAvailable
        })
    );

    const commit = (championId: string, reverse: boolean) => {
        filterState.setSearchText("");
        props.onPick(championId, reverse);
    };

    const skip = (reverse: boolean) => {
        filterState.setSearchText("");
        props.onSkip?.(reverse);
    };

    const moveHighlight = (delta: number) => {
        const count = filterState.filteredItems().length;
        if (count === 0) return;
        setHighlightedIndex((i) => Math.min(Math.max(i + delta, 0), count - 1));
        setArmed(true);
    };

    // The canvas stays interactive while the picker is open, so never fight
    // another focused editor (draft/group names) for ANY key — mirrors
    // ChampionPanel's type-anywhere guard (ChampionPanel.tsx:78).
    const isForeignInputFocused = () => {
        const active = document.activeElement;
        return (
            active instanceof HTMLElement &&
            active !== searchInputRef &&
            (active.tagName === "INPUT" ||
                active.tagName === "TEXTAREA" ||
                active.tagName === "SELECT" ||
                active.isContentEditable)
        );
    };

    const handleKey = (e: KeyboardEvent) => {
        if (isForeignInputFocused()) return;

        if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
            return;
        }
        // Tab moves the advance target spreadsheet-style; preventDefault keeps
        // the search input focused instead of browser focus-walking (design D2).
        if (e.key === "Tab" && props.onTab) {
            e.preventDefault();
            props.onTab(e.shiftKey);
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            const action = enterAction();
            if (action.type === "commit") {
                commit(action.champion.id, e.shiftKey);
            } else {
                skip(e.shiftKey);
            }
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            moveHighlight(1);
            return;
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            moveHighlight(-1);
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            moveHighlight(GRID_COLS);
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            moveHighlight(-GRID_COLS);
            return;
        }
        // Type-anywhere: route printable keys into the search box.
        if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
        if (document.activeElement === searchInputRef) return;
        e.preventDefault();
        filterState.setSearchText(filterState.searchText() + e.key);
        searchInputRef?.focus();
    };

    // Mounted only while the picker is open, so listener lifetime == open.
    window.addEventListener("keydown", handleKey);
    onCleanup(() => window.removeEventListener("keydown", handleKey));

    // Clear search and refocus per advance target (runs on mount too — the
    // initial auto-focus).
    createEffect(
        on(
            () => props.targetKey,
            () => {
                filterState.setSearchText("");
                queueMicrotask(() => searchInputRef?.focus());
            }
        )
    );

    const enterCommitName = createMemo(() => {
        const action = enterAction();
        return action.type === "commit" ? action.champion.name : null;
    });

    return (
        <div class="relative flex min-h-0 flex-col overflow-hidden rounded-b-lg border border-darius-border bg-darius-card shadow-xl">
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
                <div ref={gridRef} class="grid grid-cols-5 gap-1.5">
                    <For each={filterState.filteredItems()}>
                        {({ item: champion }, index) => {
                            const available = () => props.isAvailable(champion.id);
                            const highlighted = () => highlightedIndex() === index();
                            return (
                                <button
                                    type="button"
                                    data-grid-idx={index()}
                                    onClick={() => {
                                        if (available()) commit(champion.id, false);
                                    }}
                                    onMouseEnter={() => setHighlightedIndex(index())}
                                    disabled={!available()}
                                    title={champion.name}
                                    class="relative aspect-square overflow-hidden rounded border-2 transition-all"
                                    classList={{
                                        "border-slate-700 opacity-30 cursor-not-allowed":
                                            !available(),
                                        "border-darius-crimson ring-2 ring-darius-crimson/40":
                                            available() && highlighted(),
                                        "border-darius-border hover:border-darius-purple-bright":
                                            available() && !highlighted()
                                    }}
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
                        <Show when={enterCommitName()} fallback={<span>Skip</span>}>
                            {(name) => (
                                <span>
                                    Pick{" "}
                                    <span class="text-darius-text-primary">{name()}</span>
                                </span>
                            )}
                        </Show>
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
        </div>
    );
};
