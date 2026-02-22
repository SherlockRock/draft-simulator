import { Component, createMemo, createSignal, For, Show } from "solid-js";
import { FilterBar } from "./FilterBar";
import { useFilterableItems } from "../hooks/useFilterableItems";
import {
    champions,
    championCategories,
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
    restrictedChampionGameMap: () => Map<
        string,
        { gameNumber: number; pickIndex: number }
    >;
    draft: () => draft | undefined;
    versusDraft: () => VersusDraft | undefined;
    isMyTurn: () => boolean;
    isPaused: () => boolean;
    getCurrentPendingChampion: () => string | null;
    onChampionSelect: (champId: string) => void;
}

export const ChampionPanel: Component<ChampionPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(true);

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
    const isFiltering = createMemo(
        () => searchText() !== "" || selectedCategory() !== ""
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

    // Champions not in restricted list (for Available section)
    const availableChampions = createMemo(() => {
        const restricted = new Set(props.restrictedChampions());
        const currentPicks = new Set(props.draft()?.picks ?? []);

        return champions
            .map((champ, index) => ({ champ, index: String(index) }))
            .filter(({ index }) => !restricted.has(index) && !currentPicks.has(index));
    });

    // Inner component for a single game's restricted champions row
    const GameRestrictedRow: Component<{ game: GameRestrictions }> = (gameProps) => {
        // Combine champions based on mode
        const allChampions = createMemo(() => {
            const champs: { id: string; pickIndex: number }[] = [];

            if (showBansInRestrictions()) {
                // Ironman: include bans
                gameProps.game.blueBans.forEach((id, i) => {
                    if (id && id !== "") champs.push({ id, pickIndex: i });
                });
                gameProps.game.redBans.forEach((id, i) => {
                    if (id && id !== "") champs.push({ id, pickIndex: 5 + i });
                });
            }

            // Always include picks
            gameProps.game.bluePicks.forEach((id, i) => {
                if (id && id !== "") champs.push({ id, pickIndex: 10 + i });
            });
            gameProps.game.redPicks.forEach((id, i) => {
                if (id && id !== "") champs.push({ id, pickIndex: 15 + i });
            });

            return champs;
        });

        const gameBgColor = () => {
            // Map text colors to bg colors
            const colorMap: Record<number, string> = {
                1: "bg-cyan-600",
                2: "bg-amber-600",
                3: "bg-fuchsia-600",
                4: "bg-violet-600",
                5: "bg-sky-600",
                6: "bg-emerald-600",
                7: "bg-rose-600"
            };
            return colorMap[gameProps.game.gameNumber] ?? "bg-slate-600";
        };

        return (
            <div class="mb-4 flex">
                {/* Sidebar badge */}
                <div
                    class={`flex w-10 flex-shrink-0 flex-col items-center justify-center rounded-l ${gameBgColor()}`}
                >
                    <span class="text-[10px] font-bold text-white">Game</span>
                    <span class="text-lg font-bold text-white">
                        {gameProps.game.gameNumber}
                    </span>
                </div>

                {/* Champions grid - 5 per row */}
                <div class="grid flex-1 grid-cols-5 gap-1 px-2">
                    <For each={allChampions()}>
                        {({ id, pickIndex }) => {
                            const champ = champions[parseInt(id)];
                            if (!champ) return null;

                            const parts = getDraftPositionParts(pickIndex);
                            const gameNum = gameProps.game.gameNumber;

                            return (
                                <div
                                    class={`relative h-14 w-14 overflow-hidden rounded border-2 ${gameBorderColors[gameNum] ?? "border-slate-600"}`}
                                >
                                    <img
                                        src={champ.img}
                                        alt={champ.name}
                                        class="h-full w-full object-cover opacity-50"
                                        title={`${champ.name} - Game ${gameNum} ${getDraftPositionText(pickIndex)}`}
                                    />
                                    {/* Position badge - T# P# format (no game number since it's in sidebar) */}
                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-slate-900/85 px-1 py-px text-[9px] font-bold leading-tight">
                                        <span class={overlayTeamColor}>
                                            T{parts.team}
                                        </span>
                                        <span class={getPositionColor(parts.type)}>
                                            {parts.type}
                                            {parts.num}
                                        </span>
                                    </div>
                                </div>
                            );
                        }}
                    </For>
                </div>
            </div>
        );
    };

    return (
        <div
            class={`flex flex-col border-l border-slate-700 bg-slate-800 transition-all duration-300 ${
                isExpanded() ? "w-96" : "w-5"
            }`}
        >
            <div class="flex h-full">
                {/* Toggle button */}
                <button
                    onClick={() => setIsExpanded(!isExpanded())}
                    class="flex w-5 flex-shrink-0 items-center justify-center border-r border-slate-700/30 bg-slate-800 transition-colors hover:bg-slate-700"
                >
                    <span class="text-[10px] text-slate-500">
                        {isExpanded() ? "▶" : "◀"}
                    </span>
                </button>

                {/* Content area */}
                <Show when={isExpanded()}>
                    <div class="flex flex-1 flex-col">
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
                        {/* Game restricted sections */}
                        <Show when={props.restrictedByGame().length > 0}>
                            <For each={props.restrictedByGame()}>
                                {(game) => <GameRestrictedRow game={game} />}
                            </For>
                        </Show>

                        {/* Available section */}
                        <div class="mt-4">
                            <div class="mb-3 text-center text-sm font-medium text-slate-400">
                                Available
                            </div>
                            <div class="grid grid-cols-5 gap-2">
                                <For each={availableChampions()}>
                                    {({ champ, index }) => {
                                        const isPendingSelection = () =>
                                            props.getCurrentPendingChampion() === index &&
                                            props.isMyTurn();
                                        const canSelect = () =>
                                            props.isMyTurn() && !props.isPaused();

                                        return (
                                            <button
                                                onClick={() =>
                                                    canSelect() &&
                                                    props.onChampionSelect(index)
                                                }
                                                class={`relative h-14 w-14 overflow-hidden rounded border-2 transition-all ${
                                                    isPendingSelection()
                                                        ? "scale-110 cursor-pointer border-4 border-orange-400 ring-4 ring-orange-400/50"
                                                        : canSelect()
                                                          ? "cursor-pointer border-slate-500 hover:scale-105 hover:border-slate-300"
                                                          : "cursor-default border-slate-600"
                                                }`}
                                                title={champ.name}
                                            >
                                                <img
                                                    src={champ.img}
                                                    alt={champ.name}
                                                    class="h-full w-full object-cover"
                                                />
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>
                </Show>

                <Show when={isFiltering()}>
                    <div class="grid grid-cols-5 content-start gap-2 p-4">
                        <For each={filteredChampions()}>
                            {({ item: champ, originalIndex }) => {
                                const champId = () => String(originalIndex);
                                const isPicked = () =>
                                    (props.draft()?.picks ?? []).includes(champId());
                                const isSeriesRestricted = () =>
                                    props.restrictedChampions().includes(champId());
                                const isPendingSelection = () =>
                                    props.getCurrentPendingChampion() === champId() &&
                                    props.isMyTurn();
                                const canSelect = () =>
                                    props.isMyTurn() &&
                                    !isPicked() &&
                                    !isSeriesRestricted() &&
                                    !props.isPaused();
                                const restrictionInfo = () =>
                                    props.restrictedChampionGameMap().get(champId());
                                const currentPickIndex = () => {
                                    const picks = props.draft()?.picks ?? [];
                                    return picks.indexOf(champId());
                                };

                                return (
                                    <div class="group relative">
                                        <button
                                            onClick={() =>
                                                canSelect() &&
                                                props.onChampionSelect(champId())
                                            }
                                            class={`relative h-14 w-14 overflow-hidden rounded border-2 transition-all ${
                                                isPendingSelection()
                                                    ? "scale-110 cursor-pointer border-4 border-orange-400 ring-4 ring-orange-400/50"
                                                    : isSeriesRestricted() &&
                                                        !isPendingSelection()
                                                      ? `cursor-not-allowed ${gameBorderColors[restrictionInfo()?.gameNumber ?? 1] ?? "border-slate-700"}`
                                                      : isPicked() &&
                                                          !isPendingSelection()
                                                        ? `cursor-not-allowed ${gameBorderColors[currentGameNumber()] ?? "border-slate-700"}`
                                                        : canSelect()
                                                          ? "cursor-pointer border-slate-500 hover:scale-105 hover:border-slate-300"
                                                          : "cursor-default border-slate-600"
                                            }`}
                                            title={champ.name}
                                        >
                                            <img
                                                src={champ.img}
                                                alt={champ.name}
                                                class={`h-full w-full object-cover ${
                                                    (isPicked() ||
                                                        isSeriesRestricted()) &&
                                                    !isPendingSelection()
                                                        ? "opacity-40"
                                                        : ""
                                                }`}
                                            />
                                            {/* Restricted overlay badge */}
                                            <Show
                                                when={
                                                    isSeriesRestricted() &&
                                                    !isPendingSelection()
                                                }
                                            >
                                                {(() => {
                                                    const info = restrictionInfo();
                                                    const parts = getDraftPositionParts(
                                                        info?.pickIndex ?? 0
                                                    );
                                                    const gameNum = info?.gameNumber ?? 1;
                                                    return (
                                                        <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-slate-900/85 px-1 py-px text-[9px] font-bold leading-tight">
                                                            <span
                                                                class={
                                                                    gameTextColorsMuted[
                                                                        gameNum
                                                                    ] ?? "text-slate-300"
                                                                }
                                                            >
                                                                G{gameNum}
                                                            </span>
                                                            <span>
                                                                <span
                                                                    class={
                                                                        overlayTeamColor
                                                                    }
                                                                >
                                                                    T{parts.team}
                                                                </span>
                                                                <span
                                                                    class={getPositionColor(
                                                                        parts.type
                                                                    )}
                                                                >
                                                                    {parts.type}
                                                                    {parts.num}
                                                                </span>
                                                            </span>
                                                        </div>
                                                    );
                                                })()}
                                            </Show>
                                            {/* Current game picked overlay badge */}
                                            <Show
                                                when={
                                                    isPicked() &&
                                                    !isSeriesRestricted() &&
                                                    !isPendingSelection()
                                                }
                                            >
                                                {(() => {
                                                    const parts =
                                                        getDraftPositionParts(
                                                            currentPickIndex()
                                                        );
                                                    const gameNum = currentGameNumber();
                                                    return (
                                                        <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-slate-900/85 px-1 py-px text-[9px] font-bold leading-tight">
                                                            <span
                                                                class={
                                                                    gameTextColorsMuted[
                                                                        gameNum
                                                                    ] ?? "text-slate-300"
                                                                }
                                                            >
                                                                G{gameNum}
                                                            </span>
                                                            <span>
                                                                <span
                                                                    class={
                                                                        overlayTeamColor
                                                                    }
                                                                >
                                                                    T{parts.team}
                                                                </span>
                                                                <span
                                                                    class={getPositionColor(
                                                                        parts.type
                                                                    )}
                                                                >
                                                                    {parts.type}
                                                                    {parts.num}
                                                                </span>
                                                            </span>
                                                        </div>
                                                    );
                                                })()}
                                            </Show>
                                        </button>
                                    </div>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </div>
                    </div>
                </Show>
            </div>
        </div>
    );
};
