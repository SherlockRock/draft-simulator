import { createSignal, createEffect, For, Show } from "solid-js";
import { Dialog } from "./Dialog";
import {
    champions,
    EMOJI_OPTIONS,
    championCategories,
    emojiCategories
} from "../utils/constants";
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "./FilterBar";
import { SelectTheme, getThemeColors } from "../utils/selectTheme";

interface IconPickerProps {
    isOpen: () => boolean;
    onClose: () => void;
    onSelect: (icon: string) => void;
    currentIcon?: string;
    theme?: SelectTheme;
}

export const IconPicker = (props: IconPickerProps) => {
    const [activeTab, setActiveTab] = createSignal<"champions" | "emojis">("champions");
    const colors = () => getThemeColors(props.theme ?? "teal");

    // Champion filtering
    const championFilter = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Emoji filtering
    const emojiFilter = useFilterableItems({
        items: EMOJI_OPTIONS,
        categoryMap: emojiCategories
    });

    // Clear filters when switching tabs
    createEffect(() => {
        championFilter.clearFilters();
        emojiFilter.clearFilters();
    });

    const handleChampionSelect = (index: number) => {
        props.onSelect(index.toString());
        props.onClose();
    };

    const handleEmojiSelect = (emoji: string) => {
        props.onSelect(emoji);
        props.onClose();
    };

    const handleClearIcon = () => {
        props.onSelect("");
        props.onClose();
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="h-[65vh] w-[90vw] max-w-4xl">
                    <div class="mb-4 flex items-center justify-between">
                        <h2 class="text-xl font-bold text-slate-50">Select Icon</h2>
                        <button
                            onClick={handleClearIcon}
                            class="rounded-md bg-slate-600 px-3 py-1 text-sm font-medium text-slate-200 hover:bg-slate-500"
                        >
                            Clear Icon
                        </button>
                    </div>

                    {/* Tabs */}
                    <div class="mb-4 flex gap-2 border-b border-slate-600">
                        <button
                            onClick={() => setActiveTab("champions")}
                            class={`px-4 py-2 text-sm font-medium transition-colors ${
                                activeTab() === "champions"
                                    ? `border-b-2 ${colors().activeBorder} ${colors().text}`
                                    : "text-slate-400 hover:text-slate-300"
                            }`}
                        >
                            Champions
                        </button>
                        <button
                            onClick={() => setActiveTab("emojis")}
                            class={`px-4 py-2 text-sm font-medium transition-colors ${
                                activeTab() === "emojis"
                                    ? `border-b-2 ${colors().activeBorder} ${colors().text}`
                                    : "text-slate-400 hover:text-slate-300"
                            }`}
                        >
                            Emojis
                        </button>
                    </div>

                    {/* Content */}
                    <div class="h-[50vh] overflow-y-auto overflow-x-hidden">
                        <Show when={activeTab() === "champions"}>
                            <div class="mb-2 p-2">
                                <FilterBar
                                    searchText={championFilter.searchText}
                                    onSearchChange={championFilter.setSearchText}
                                    selectedCategory={championFilter.selectedCategory}
                                    onCategoryChange={championFilter.setSelectedCategory}
                                    categories={championFilter.categories}
                                    searchPlaceholder="Search champions..."
                                    categoryPlaceholder="Role"
                                    theme={props.theme}
                                />
                            </div>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={championFilter.filteredItems()}>
                                    {({ item: champion, originalIndex }) => (
                                        <button
                                            onClick={() =>
                                                handleChampionSelect(originalIndex)
                                            }
                                            class={`group relative aspect-square overflow-hidden rounded border-2 transition-all hover:scale-105 ${
                                                props.currentIcon ===
                                                originalIndex.toString()
                                                    ? `${colors().dropdownBorder} ring-2 ${colors().ringColor}`
                                                    : `border-slate-600 ${colors().hoverBorderLight}`
                                            }`}
                                            title={champion.name}
                                        >
                                            <img
                                                src={champion.img}
                                                alt={champion.name}
                                                class="h-full w-full object-cover"
                                            />
                                            <div class="absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 transition-opacity group-hover:opacity-100">
                                                <span class="text-xs text-white">
                                                    {champion.name}
                                                </span>
                                            </div>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>

                        <Show when={activeTab() === "emojis"}>
                            <div class="mb-2 p-2">
                                <FilterBar
                                    searchText={emojiFilter.searchText}
                                    onSearchChange={emojiFilter.setSearchText}
                                    selectedCategory={emojiFilter.selectedCategory}
                                    onCategoryChange={emojiFilter.setSelectedCategory}
                                    categories={emojiFilter.categories}
                                    searchPlaceholder="Search emojis..."
                                    categoryPlaceholder="Category"
                                    theme={props.theme}
                                />
                            </div>
                            <div class="grid grid-cols-8 gap-2 p-2 sm:grid-cols-10 md:grid-cols-12">
                                <For each={emojiFilter.filteredItems()}>
                                    {({ item: emojiItem }) => (
                                        <button
                                            onClick={() =>
                                                handleEmojiSelect(emojiItem.emoji)
                                            }
                                            class={`flex aspect-square items-center justify-center rounded border-2 text-3xl transition-all hover:scale-105 ${
                                                props.currentIcon === emojiItem.emoji
                                                    ? `${colors().dropdownBorder} bg-slate-700 ring-2 ${colors().ringColor}`
                                                    : `border-slate-600 bg-slate-800 ${colors().hoverBorderLight} hover:bg-slate-700`
                                            }`}
                                            title={emojiItem.name}
                                        >
                                            {emojiItem.emoji}
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>

                    <div class="mt-4 flex justify-end">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            }
        />
    );
};
