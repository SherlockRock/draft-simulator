import { Component, createMemo, For, Show } from "solid-js";
import { FilterBar } from "./FilterBar";
import { useFilterableItems } from "../hooks/useFilterableItems";
import {
    champions,
    championCategories,
    gameTextColors,
    gameTextColorsMuted,
    gameBorderColors,
    overlayTeamColor,
    overlayBanColor,
    overlayPickColor
} from "../utils/constants";
import type { GameRestrictions } from "../utils/seriesRestrictions";
import type { draft, VersusDraft } from "../utils/schemas";

interface ChampionPanelProps {
    restrictedByGame: () => GameRestrictions[];
    restrictedChampions: () => string[];
    restrictedChampionGameMap: () => Map<string, { gameNumber: number; pickIndex: number }>;
    draft: () => draft | undefined;
    versusDraft: () => VersusDraft | undefined;
    isMyTurn: () => boolean;
    isPaused: () => boolean;
    getCurrentPendingChampion: () => string | null;
    onChampionSelect: (champId: string) => void;
}

export const ChampionPanel: Component<ChampionPanelProps> = (props) => {
    // Filtering state
    const {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList
    } = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Derived: are we filtering?
    const isFiltering = createMemo(() =>
        searchText() !== "" || selectedCategory() !== ""
    );

    // Parse pick index into components for colorized rendering
    const getDraftPositionParts = (
        pickIndex: number
    ): { team: number; type: "B" | "P"; num: number } => {
        if (pickIndex < 5) return { team: 1, type: "B", num: pickIndex + 1 };
        if (pickIndex < 10) return { team: 2, type: "B", num: pickIndex - 4 };
        if (pickIndex < 15) return { team: 1, type: "P", num: pickIndex - 9 };
        return { team: 2, type: "P", num: pickIndex - 14 };
    };

    // Get color class for a position (ban or pick)
    const getPositionColor = (type: "B" | "P"): string => {
        return type === "B" ? overlayBanColor : overlayPickColor;
    };

    // Convert a picks array index to full-text label for tooltips
    const getDraftPositionText = (pickIndex: number): string => {
        if (pickIndex < 5) return `Team 1 Ban ${pickIndex + 1}`;
        if (pickIndex < 10) return `Team 2 Ban ${pickIndex - 4}`;
        if (pickIndex < 15) return `Team 1 Pick ${pickIndex - 9}`;
        return `Team 2 Pick ${pickIndex - 14}`;
    };

    // Current game number
    const currentGameNumber = () => (props.draft()?.seriesIndex ?? 0) + 1;

    // Check if draft type shows bans in restrictions (ironman only)
    const showBansInRestrictions = () => props.versusDraft()?.type === "ironman";

    return (
        <div class="flex w-96 flex-col border-l border-slate-700 bg-slate-800">
            {/* Filter bar - fixed at top */}
            <div class="border-b border-slate-700 px-4 py-3">
                <FilterBar
                    searchText={searchText}
                    onSearchChange={setSearchText}
                    selectedCategory={selectedCategory}
                    onCategoryChange={setSelectedCategory}
                    categories={championCategoryList}
                    searchPlaceholder="Search champions..."
                    categoryPlaceholder="Role"
                    theme="orange"
                />
            </div>

            {/* Content area */}
            <div class="flex-1 overflow-y-auto">
                <Show when={!isFiltering()}>
                    <div class="p-4">
                        {/* Unified view placeholder */}
                        <p class="text-slate-400">Unified view (game sections + available)</p>
                    </div>
                </Show>

                <Show when={isFiltering()}>
                    <div class="p-4">
                        {/* Filtered view placeholder */}
                        <p class="text-slate-400">Filtered view (overlay grid)</p>
                    </div>
                </Show>
            </div>
        </div>
    );
};
