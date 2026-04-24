import { Component, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { X } from "lucide-solid";
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

const ChampionPicker: Component<ChampionPickerProps> = (props) => {
    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
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

    // Close on Escape.
    createEffect(() => {
        if (!props.isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
            }
        };
        window.addEventListener("keydown", handleKey);
        onCleanup(() => window.removeEventListener("keydown", handleKey));
    });

    const actionVerb = createMemo(() => props.actionVerb ?? "Pick");

    return (
        <Show when={props.isOpen}>
            <div
                class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
                onClick={() => props.onClose()}
            >
                <div
                    class="relative flex w-full max-w-sm flex-col overflow-hidden rounded-lg border border-darius-border bg-darius-card shadow-xl"
                    onClick={(e) => e.stopPropagation()}
                >
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

                    {/* Grid placeholder — filled in Task 3 */}
                    <div class="flex h-80 items-center justify-center text-sm text-darius-text-secondary">
                        Grid: {filterState.filteredItems().length} champions
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
                                        {/* Champion name — filled in Task 4 */}
                                        —
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
                </div>
            </div>
        </Show>
    );
};

export default ChampionPicker;
