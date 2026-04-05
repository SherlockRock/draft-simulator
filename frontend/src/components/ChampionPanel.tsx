import { Component, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { X } from "lucide-solid";
import { FilterBar } from "./FilterBar";
import { RoleFilter } from "./RoleFilter";
import { useMultiFilterableItems } from "../hooks/useFilterableItems";
import {
    champions,
    championCategories,
    gameTextColorsMuted,
    gameBorderColors,
    gameBgColors,
    overlayTeamColor,
    overlayBanColor,
    overlayPickColor
} from "../utils/constants";
import type { draft } from "../utils/schemas";

export interface RestrictionGroup {
    label: string;
    colorIndex: number;
    blueBans: string[];
    redBans: string[];
    bluePicks: string[];
    redPicks: string[];
}

export interface RestrictionMapEntry {
    label: string;
    colorIndex: number;
    pickIndex: number;
}

interface ChampionPanelProps {
    restrictionGroups: () => RestrictionGroup[];
    restrictedChampions: () => string[];
    restrictedChampionMap: () => Map<string, RestrictionMapEntry>;
    disabledChampions?: () => string[];
    draft: () => draft | undefined;
    showBansInRestrictions: () => boolean;
    isMyTurn: () => boolean;
    isPaused: () => boolean;
    getCurrentPendingChampion: () => string | null;
    onChampionSelect: (champId: string) => void;
    keyboardControls?: boolean;
}

export const ChampionPanel: Component<ChampionPanelProps> = (props) => {
    const [isExpanded, setIsExpanded] = createSignal(true);

    // Filtering state
    const {
        searchText,
        setSearchText,
        selectedCategories,
        toggleCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList,
        clearCategories
    } = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Ref for FilterBar input (for programmatic focus)
    let filterInputRef: HTMLInputElement | undefined;

    // Window-level keydown listener for type-anywhere filtering
    // Non-reactive prop check is intentional — ChampionPanel is recreated per draft,
    // so the setting value at creation time is stable for the component's lifetime.
    if (props.keyboardControls) {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip if panel is collapsed
            if (!isExpanded()) return;

            // Skip if any input/textarea/select is focused (except our FilterBar)
            const active = document.activeElement;
            if (
                active &&
                active !== filterInputRef &&
                (active.tagName === "INPUT" ||
                    active.tagName === "TEXTAREA" ||
                    active.tagName === "SELECT")
            ) {
                return;
            }

            // Escape: clear search and blur
            if (e.key === "Escape") {
                if (searchText() !== "") {
                    setSearchText("");
                    filterInputRef?.blur();
                    e.preventDefault();
                }
                return;
            }

            // Skip modifier keys, function keys, and non-printable keys
            if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) {
                return;
            }

            // If FilterBar input is already focused, let native handling work
            if (document.activeElement === filterInputRef) return;

            // Redirect: focus input, set search text
            e.preventDefault();
            setSearchText(searchText() + e.key);
            filterInputRef?.focus();
        };

        window.addEventListener("keydown", handleKeyDown);
        onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
    }

    // Wrapper to clear search on champion select
    const handleChampionSelect = (champId: string) => {
        props.onChampionSelect(champId);
        if (props.keyboardControls) {
            setSearchText("");
            filterInputRef?.blur();
        }
    };

    // Derived: are we filtering?
    const isFiltering = createMemo(
        () => searchText() !== "" || selectedCategories().size > 0
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

    const getRestrictionLabelShort = (label: string): string => {
        const gameMatch = /^Game\s+(\d+)$/i.exec(label.trim());
        if (gameMatch) {
            return `G${gameMatch[1]}`;
        }

        const compactLabel = label.replace(/\s+/g, " ").trim();
        return compactLabel.slice(0, 4) || "R";
    };

    // Current game number
    const currentGameNumber = () => (props.draft()?.seriesIndex ?? 0) + 1;

    // Memoize picks as a Set to avoid per-button .includes() on array
    const pickedSet = createMemo(() => new Set(props.draft()?.picks ?? []));

    // Champions not in restricted or disabled list (for Available section)
    // Current game picks stay visible but are rendered as disabled
    const availableChampions = createMemo(() => {
        const restricted = new Set(props.restrictedChampions());
        const disabled = new Set(props.disabledChampions?.() ?? []);

        return champions
            .map((champ, index) => ({ champ, index: String(index) }))
            .filter(({ index }) => !restricted.has(index) && !disabled.has(index));
    });

    // Inner component for a single restriction group's champions row
    const RestrictionGroupRow: Component<{ group: RestrictionGroup }> = (groupProps) => {
        // Combine champions based on mode
        const allChampions = createMemo(() => {
            const champs: { id: string; pickIndex: number }[] = [];

            if (props.showBansInRestrictions()) {
                groupProps.group.blueBans.forEach((id, i) => {
                    if (id && id !== "") champs.push({ id, pickIndex: i });
                });
                groupProps.group.redBans.forEach((id, i) => {
                    if (id && id !== "") champs.push({ id, pickIndex: 5 + i });
                });
            }

            groupProps.group.bluePicks.forEach((id, i) => {
                if (id && id !== "") champs.push({ id, pickIndex: 10 + i });
            });
            groupProps.group.redPicks.forEach((id, i) => {
                if (id && id !== "") champs.push({ id, pickIndex: 15 + i });
            });

            return champs;
        });

        const gameBgColor = () => {
            return gameBgColors[groupProps.group.colorIndex] ?? "bg-darius-border";
        };

        return (
            <div class="mb-4 flex">
                {/* Sidebar badge */}
                <div
                    class={`flex w-10 flex-shrink-0 flex-col items-center justify-center rounded-l ${gameBgColor()}`}
                >
                    <span
                        class="max-h-[80px] overflow-hidden text-[10px] font-bold uppercase tracking-widest text-white"
                        style={{ "writing-mode": "vertical-lr" }}
                        title={groupProps.group.label}
                    >
                        {groupProps.group.label}
                    </span>
                </div>

                {/* Champions grid - 5 per row */}
                <div class="grid flex-1 grid-cols-5 gap-1 px-2">
                    <For each={allChampions()}>
                        {({ id, pickIndex }) => {
                            const champ = champions[parseInt(id)];
                            if (!champ) return null;

                            const parts = getDraftPositionParts(pickIndex);
                            const colorIndex = groupProps.group.colorIndex;

                            return (
                                <div
                                    class={`relative aspect-square w-full overflow-hidden rounded border-2 ${gameBorderColors[colorIndex] ?? "border-darius-border"}`}
                                >
                                    <img
                                        src={champ.img}
                                        alt={champ.name}
                                        class="h-full w-full object-cover opacity-50"
                                        title={`${champ.name} - ${groupProps.group.label} ${getDraftPositionText(pickIndex)}`}
                                    />
                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-1 py-px text-[9px] font-bold leading-tight">
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
            class={`flex flex-col border-l border-darius-border bg-darius-card transition-[width] duration-300 ${
                isExpanded() ? "w-[min(26vw,384px)]" : "w-5"
            }`}
        >
            <div class="flex h-full">
                {/* Toggle button */}
                <button
                    onClick={() => setIsExpanded(!isExpanded())}
                    class="group flex w-5 flex-shrink-0 items-center justify-center border-r border-darius-border bg-darius-card bg-darius-card-hover transition-colors"
                >
                    <span class="text-[10px] text-darius-crimson text-darius-text-secondary transition-colors">
                        {isExpanded() ? "▶" : "◀"}
                    </span>
                </button>

                {/* Content area */}
                <Show when={isExpanded()}>
                    <div class="flex flex-1 flex-col">
                        {/* Filter bar - fixed at top */}
                        <div class="border-b border-darius-border px-4 py-3">
                            <FilterBar
                                searchText={searchText}
                                onSearchChange={setSearchText}
                                searchPlaceholder="Search champions..."
                                inputRef={(el) => {
                                    filterInputRef = el;
                                }}
                                accent="orange"
                            />
                            <RoleFilter
                                categories={championCategoryList}
                                selectedCategories={selectedCategories}
                                onToggle={toggleCategory}
                                onClearAll={clearCategories}
                                theme="crimson"
                            />
                        </div>

                        {/* Content area */}
                        <div class="custom-scrollbar flex-1 overflow-y-auto">
                            <Show when={!isFiltering()}>
                                <div class="p-4">
                                    {/* Disabled champions section */}
                                    <Show
                                        when={
                                            (props.disabledChampions?.() ?? []).length > 0
                                        }
                                    >
                                        <div class="mb-4 flex min-h-[4rem]">
                                            <div class="flex w-10 flex-shrink-0 flex-col items-center justify-center rounded-l bg-red-700">
                                                <span
                                                    class="text-[10px] font-bold uppercase tracking-widest text-white"
                                                    style={{
                                                        "writing-mode": "vertical-lr"
                                                    }}
                                                >
                                                    Disabled
                                                </span>
                                            </div>
                                            <div class="grid flex-1 grid-cols-5 content-center gap-1 px-2">
                                                <For
                                                    each={
                                                        props.disabledChampions?.() ?? []
                                                    }
                                                >
                                                    {(id) => {
                                                        const champ =
                                                            champions[parseInt(id)];
                                                        if (!champ) return null;
                                                        return (
                                                            <div
                                                                class="relative aspect-square w-full overflow-hidden rounded border-2 border-red-700"
                                                                title={`${champ.name} - Disabled For Series`}
                                                            >
                                                                <img
                                                                    src={champ.img}
                                                                    alt={champ.name}
                                                                    class="h-full w-full object-cover opacity-50"
                                                                />
                                                                <div class="absolute inset-0 flex items-center justify-center">
                                                                    <X
                                                                        size={20}
                                                                        class="text-red-400"
                                                                    />
                                                                </div>
                                                            </div>
                                                        );
                                                    }}
                                                </For>
                                            </div>
                                        </div>
                                    </Show>

                                    {/* Restriction group sections */}
                                    <Show when={props.restrictionGroups().length > 0}>
                                        <For each={props.restrictionGroups()}>
                                            {(group) => (
                                                <RestrictionGroupRow group={group} />
                                            )}
                                        </For>
                                    </Show>

                                    {/* Available section */}
                                    <div class="mt-4">
                                        <div class="mb-3 text-center text-sm font-medium text-darius-text-secondary">
                                            Available
                                        </div>
                                        <div class="grid grid-cols-5 gap-2">
                                            <For each={availableChampions()}>
                                                {({ champ, index }) => {
                                                    const isPicked = () =>
                                                        pickedSet().has(index);
                                                    const isPendingSelection = () =>
                                                        props.getCurrentPendingChampion() ===
                                                            index && props.isMyTurn();
                                                    const canSelect = () =>
                                                        props.isMyTurn() &&
                                                        !isPicked() &&
                                                        !props.isPaused();
                                                    const currentPickIndex = () => {
                                                        const picks =
                                                            props.draft()?.picks ?? [];
                                                        return picks.indexOf(index);
                                                    };

                                                    return (
                                                        <button
                                                            onClick={() =>
                                                                canSelect() &&
                                                                handleChampionSelect(
                                                                    index
                                                                )
                                                            }
                                                            class={`relative aspect-square w-full overflow-hidden rounded border-2 transition-[transform,border-color,box-shadow] duration-150 [contain:content] ${
                                                                isPendingSelection()
                                                                    ? "scale-110 cursor-pointer border-4 border-darius-ember ring-4 ring-darius-ember/50"
                                                                    : isPicked() &&
                                                                        !isPendingSelection()
                                                                      ? `cursor-not-allowed ${gameBorderColors[currentGameNumber()] ?? "border-darius-border"}`
                                                                      : canSelect()
                                                                        ? "cursor-pointer border-darius-border hover:scale-105 hover:border-darius-purple-bright"
                                                                        : "cursor-default border-darius-border"
                                                            }`}
                                                            title={
                                                                isPicked()
                                                                    ? `${champ.name} - Game ${currentGameNumber()} ${getDraftPositionText(currentPickIndex())}`
                                                                    : champ.name
                                                            }
                                                        >
                                                            <img
                                                                src={champ.img}
                                                                alt={champ.name}
                                                                class={`h-full w-full object-cover ${
                                                                    isPicked() &&
                                                                    !isPendingSelection()
                                                                        ? "opacity-40"
                                                                        : ""
                                                                }`}
                                                            />
                                                            {/* Current game picked overlay badge */}
                                                            <Show
                                                                when={
                                                                    isPicked() &&
                                                                    !isPendingSelection()
                                                                }
                                                            >
                                                                {(() => {
                                                                    const parts =
                                                                        getDraftPositionParts(
                                                                            currentPickIndex()
                                                                        );
                                                                    const gameNum =
                                                                        currentGameNumber();
                                                                    return (
                                                                        <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-1 py-px text-[9px] font-bold leading-tight">
                                                                            <span
                                                                                class={
                                                                                    gameTextColorsMuted[
                                                                                        gameNum
                                                                                    ] ??
                                                                                    "text-darius-text-secondary"
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
                                                                                    T
                                                                                    {
                                                                                        parts.team
                                                                                    }
                                                                                </span>
                                                                                <span
                                                                                    class={getPositionColor(
                                                                                        parts.type
                                                                                    )}
                                                                                >
                                                                                    {
                                                                                        parts.type
                                                                                    }
                                                                                    {
                                                                                        parts.num
                                                                                    }
                                                                                </span>
                                                                            </span>
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </Show>
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
                                                pickedSet().has(champId());
                                            const isRestricted = () =>
                                                props
                                                    .restrictedChampionMap()
                                                    .has(champId());
                                            const isDisabled = () =>
                                                (
                                                    props.disabledChampions?.() ?? []
                                                ).includes(champId());
                                            const isPendingSelection = () =>
                                                props.getCurrentPendingChampion() ===
                                                    champId() && props.isMyTurn();
                                            const canSelect = () =>
                                                props.isMyTurn() &&
                                                !isPicked() &&
                                                !isRestricted() &&
                                                !isDisabled() &&
                                                !props.isPaused();
                                            const restrictionInfo = () =>
                                                props
                                                    .restrictedChampionMap()
                                                    .get(champId());
                                            const currentPickIndex = () => {
                                                const picks = props.draft()?.picks ?? [];
                                                return picks.indexOf(champId());
                                            };

                                            return (
                                                <div class="group relative">
                                                    <button
                                                        onClick={() =>
                                                            canSelect() &&
                                                            handleChampionSelect(
                                                                champId()
                                                            )
                                                        }
                                                        class={`relative aspect-square w-full overflow-hidden rounded border-2 transition-[transform,border-color,box-shadow] duration-150 [contain:content] ${
                                                            isPendingSelection()
                                                                ? "scale-110 cursor-pointer border-4 border-darius-ember ring-4 ring-darius-ember/50"
                                                                : isDisabled()
                                                                  ? "cursor-not-allowed border-red-700"
                                                                  : isRestricted() &&
                                                                      !isPendingSelection()
                                                                    ? `cursor-not-allowed ${gameBorderColors[restrictionInfo()?.colorIndex ?? 1] ?? "border-darius-border"}`
                                                                    : isPicked() &&
                                                                        !isPendingSelection()
                                                                      ? `cursor-not-allowed ${gameBorderColors[currentGameNumber()] ?? "border-darius-border"}`
                                                                      : canSelect()
                                                                        ? "cursor-pointer border-darius-border hover:scale-105 hover:border-darius-purple-bright"
                                                                        : "cursor-default border-darius-border"
                                                        }`}
                                                        title={
                                                            isDisabled()
                                                                ? `${champ.name} - Disabled For Series`
                                                                : isRestricted()
                                                                  ? `${champ.name} - ${restrictionInfo()?.label ?? "Restricted"} ${getDraftPositionText(restrictionInfo()?.pickIndex ?? 0)}`
                                                                  : isPicked()
                                                                    ? `${champ.name} - Game ${currentGameNumber()} ${getDraftPositionText(currentPickIndex())}`
                                                                    : champ.name
                                                        }
                                                    >
                                                        <img
                                                            src={champ.img}
                                                            alt={champ.name}
                                                            class={`h-full w-full object-cover ${
                                                                (isPicked() ||
                                                                    isRestricted() ||
                                                                    isDisabled()) &&
                                                                !isPendingSelection()
                                                                    ? "opacity-40"
                                                                    : ""
                                                            }`}
                                                        />
                                                        {/* Disabled overlay */}
                                                        <Show
                                                            when={
                                                                isDisabled() &&
                                                                !isPendingSelection()
                                                            }
                                                        >
                                                            <div class="absolute inset-0 flex items-center justify-center bg-red-900/40">
                                                                <X
                                                                    size={20}
                                                                    class="text-red-400"
                                                                />
                                                            </div>
                                                        </Show>
                                                        {/* Restricted overlay badge */}
                                                        <Show
                                                            when={
                                                                isRestricted() &&
                                                                !isPendingSelection()
                                                            }
                                                        >
                                                            {(() => {
                                                                const info =
                                                                    restrictionInfo();
                                                                const parts =
                                                                    getDraftPositionParts(
                                                                        info?.pickIndex ??
                                                                            0
                                                                    );
                                                                return (
                                                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-1 py-px text-[9px] font-bold leading-tight">
                                                                        <span
                                                                            class={
                                                                                gameTextColorsMuted[
                                                                                    info?.colorIndex ??
                                                                                        1
                                                                                ] ??
                                                                                "text-darius-text-secondary"
                                                                            }
                                                                            title={
                                                                                info?.label ??
                                                                                "Restricted"
                                                                            }
                                                                        >
                                                                            {getRestrictionLabelShort(
                                                                                info?.label ??
                                                                                    ""
                                                                            )}
                                                                        </span>
                                                                        <span>
                                                                            <span
                                                                                class={
                                                                                    overlayTeamColor
                                                                                }
                                                                            >
                                                                                T
                                                                                {
                                                                                    parts.team
                                                                                }
                                                                            </span>
                                                                            <span
                                                                                class={getPositionColor(
                                                                                    parts.type
                                                                                )}
                                                                            >
                                                                                {
                                                                                    parts.type
                                                                                }
                                                                                {
                                                                                    parts.num
                                                                                }
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
                                                                !isRestricted() &&
                                                                !isPendingSelection()
                                                            }
                                                        >
                                                            {(() => {
                                                                const parts =
                                                                    getDraftPositionParts(
                                                                        currentPickIndex()
                                                                    );
                                                                const gameNum =
                                                                    currentGameNumber();
                                                                return (
                                                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-1 py-px text-[9px] font-bold leading-tight">
                                                                        <span
                                                                            class={
                                                                                gameTextColorsMuted[
                                                                                    gameNum
                                                                                ] ??
                                                                                "text-darius-text-secondary"
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
                                                                                T
                                                                                {
                                                                                    parts.team
                                                                                }
                                                                            </span>
                                                                            <span
                                                                                class={getPositionColor(
                                                                                    parts.type
                                                                                )}
                                                                            >
                                                                                {
                                                                                    parts.type
                                                                                }
                                                                                {
                                                                                    parts.num
                                                                                }
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
