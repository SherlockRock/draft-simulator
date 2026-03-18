import { Component, For, Show } from "solid-js";
import { FilterBar } from "./FilterBar";
import { RoleFilter } from "./RoleFilter";
import { useMultiFilterableItems } from "../hooks/useFilterableItems";
import { champions, championCategories } from "../utils/constants";
import { X } from "lucide-solid";

interface ChampionToggleGridProps {
    selectedChampions: () => string[];
    onToggle: (champId: string) => void;
    theme?: "orange" | "purple";
}

export const ChampionToggleGrid: Component<ChampionToggleGridProps> = (props) => {
    const {
        searchText,
        setSearchText,
        selectedCategories,
        toggleCategory,
        clearCategories,
        filteredItems: filteredChampions,
        categories: championCategoryList
    } = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    const isSelected = (champId: string) => props.selectedChampions().includes(champId);

    return (
        <div class="flex flex-col gap-3">
            <div>
                <FilterBar
                    searchText={searchText}
                    onSearchChange={setSearchText}
                    searchPlaceholder="Search champions..."
                />
                <RoleFilter
                    categories={championCategoryList}
                    selectedCategories={selectedCategories}
                    onToggle={toggleCategory}
                    onClearAll={clearCategories}
                    theme={props.theme ?? "orange"}
                />
            </div>

            <div class="custom-scrollbar max-h-[320px] overflow-y-auto pr-1">
                <div class="grid grid-cols-6 gap-1.5">
                    <For each={filteredChampions()}>
                        {({ item: champ, originalIndex }) => {
                            const champId = String(originalIndex);
                            const selected = () => isSelected(champId);

                            return (
                                <button
                                    type="button"
                                    onClick={() => props.onToggle(champId)}
                                    class={`relative aspect-square overflow-hidden rounded border-2 transition-all ${
                                        selected()
                                            ? "border-red-500 opacity-60"
                                            : "border-slate-600 hover:border-slate-400"
                                    }`}
                                    title={champ.name}
                                >
                                    <img
                                        src={champ.img}
                                        alt={champ.name}
                                        class="h-full w-full object-cover"
                                    />
                                    <Show when={selected()}>
                                        <div class="absolute inset-0 flex items-center justify-center bg-red-900/40">
                                            <X size={20} class="text-red-400" />
                                        </div>
                                    </Show>
                                </button>
                            );
                        }}
                    </For>
                </div>
            </div>
        </div>
    );
};
