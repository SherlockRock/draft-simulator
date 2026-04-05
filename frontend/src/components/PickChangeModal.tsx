import {
    Component,
    Show,
    For,
    createSignal,
    createEffect,
    onCleanup,
    onMount
} from "solid-js";
import { X } from "lucide-solid";
import { draft } from "../utils/schemas";
import { getEffectiveSide } from "@draft-sim/shared-types";
import { getSideTeamName } from "../utils/versusPermissions";
import {
    champions,
    championCategories,
    gameBorderColors,
    gameTextColorsMuted,
    overlayTeamColor,
    overlayBanColor,
    overlayPickColor
} from "../utils/constants";
import { useMultiFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "./FilterBar";
import { RoleFilter } from "./RoleFilter";
import { getEffectivePickOrder, getPicksArrayIndex } from "../utils/versusPickOrder";
import type { RestrictionMapEntry } from "./ChampionPanel";

interface PickChangeRequest {
    requestId: string;
    team: "blue" | "red";
    pickIndex: number;
    oldChampion: string;
    newChampion: string;
}

interface PickChangeModalProps {
    draft?: draft;
    myRole: () => string | null;
    isCompetitive: boolean;
    blueTeamName: string;
    redTeamName: string;
    completedAt?: string | null;
    changeWindowSeconds: number;
    currentPickIndex: number;
    firstPick: "blue" | "red";
    disabledChampions?: string[];
    restrictedChampionGameMap?: Map<string, RestrictionMapEntry>;
    pendingRequest?: PickChangeRequest | null;
    onRequestChange: (pickIndex: number, newChampion: string) => void;
    onApproveChange: (requestId: string) => void;
    onRejectChange: (requestId: string) => void;
    hideButton?: boolean;
    onOpenRef?: (openFn: () => void) => void;
    onStateRef?: (state: {
        isLocked: () => boolean;
        timeRemaining: () => number | null;
        hasChangeableSlots: () => boolean;
    }) => void;
}

export const PickChangeModal: Component<PickChangeModalProps> = (props) => {
    const [isOpen, setIsOpen] = createSignal(false);
    const [selectedPickIndex, setSelectedPickIndex] = createSignal<number | null>(null);
    const [selectedChampion, setSelectedChampion] = createSignal<string | null>(null);

    const isSpectator = () => props.myRole() === "spectator";

    // Countdown timer for pick change window
    const [timeRemaining, setTimeRemaining] = createSignal<number | null>(null);

    createEffect(() => {
        const completedAt = props.completedAt;
        if (!completedAt) {
            setTimeRemaining(null);
            return;
        }

        const expiresAt =
            new Date(completedAt).getTime() + props.changeWindowSeconds * 1000;

        const update = () => {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            setTimeRemaining(remaining);
        };
        update();

        const interval = setInterval(update, 1000);
        onCleanup(() => clearInterval(interval));
    });

    const isLocked = () => {
        const remaining = timeRemaining();
        return remaining !== null && remaining <= 0;
    };

    const formatTime = (seconds: number): string => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, "0")}`;
    };

    // Compute which picks array indices have been locked in and belong to my team
    const lockedPickIndices = () => {
        if (props.draft?.completed) return null; // null = all changeable (post-completion)
        const effectiveOrder = getEffectivePickOrder(props.firstPick);
        const team = myTeam();
        const locked = new Set<number>();
        for (let i = 0; i < props.currentPickIndex; i++) {
            const item = effectiveOrder[i];
            const picksIdx = getPicksArrayIndex(i, props.firstPick);
            if (item.team === team) {
                locked.add(picksIdx);
            }
        }
        return locked;
    };

    // Find the captain's most recently locked pick/ban index
    const myLastLockedIndex = () => {
        const effectiveOrder = getEffectivePickOrder(props.firstPick);
        const team = myTeam();
        for (let i = props.currentPickIndex - 1; i >= 0; i--) {
            if (effectiveOrder[i].team === team) {
                return getPicksArrayIndex(i, props.firstPick);
            }
        }
        return null;
    };

    // Draft position helpers (matching ChampionPanel)
    const getDraftPositionParts = (
        pickIndex: number
    ): { team: number; type: "B" | "P"; num: number } => {
        if (pickIndex < 5) return { team: 1, type: "B", num: pickIndex + 1 };
        if (pickIndex < 10) return { team: 2, type: "B", num: pickIndex - 4 };
        if (pickIndex < 15) return { team: 1, type: "P", num: pickIndex - 9 };
        return { team: 2, type: "P", num: pickIndex - 14 };
    };

    const getPositionColor = (type: "B" | "P"): string => {
        return type === "B" ? overlayBanColor : overlayPickColor;
    };

    const getDraftPositionText = (pickIndex: number): string => {
        if (pickIndex < 5) return `Team 1 Ban ${pickIndex + 1}`;
        if (pickIndex < 10) return `Team 2 Ban ${pickIndex - 4}`;
        if (pickIndex < 15) return `Team 1 Pick ${pickIndex - 9}`;
        return `Team 2 Pick ${pickIndex - 14}`;
    };

    const currentGameNumber = () => (props.draft?.seriesIndex ?? 0) + 1;

    const myTeam = () => {
        const role = props.myRole();
        if (!role || role === "spectator") return "blue";
        return getEffectiveSide(role, props.draft?.blueSideTeam ?? 1);
    };

    // Champion filtering for Step 2
    const {
        searchText,
        setSearchText,
        selectedCategories,
        toggleCategory,
        clearCategories,
        filteredItems: filteredChampions,
        categories: championCategoryList,
        clearFilters
    } = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Get my team's bans for selection (filtered to locked-only during live draft)
    const getMyBans = () => {
        if (!props.draft) return [];
        const picks = props.draft.picks || [];
        const team = myTeam();

        let bans;
        if (team === "blue") {
            bans = picks
                .slice(0, 5)
                .map((champion, idx) => ({ champion, pickIndex: idx }));
        } else {
            bans = picks
                .slice(5, 10)
                .map((champion, idx) => ({ champion, pickIndex: idx + 5 }));
        }

        const locked = lockedPickIndices();
        if (locked) {
            bans = bans.filter((b) => locked.has(b.pickIndex));
        }
        return bans;
    };

    // Get my team's picks for selection (filtered to locked-only during live draft)
    const getMyPicks = () => {
        if (!props.draft) return [];
        const picks = props.draft.picks || [];
        const team = myTeam();

        let teamPicks;
        if (team === "blue") {
            teamPicks = picks
                .slice(10, 15)
                .map((champion, idx) => ({ champion, pickIndex: idx + 10 }));
        } else {
            teamPicks = picks
                .slice(15, 20)
                .map((champion, idx) => ({ champion, pickIndex: idx + 15 }));
        }

        const locked = lockedPickIndices();
        if (locked) {
            teamPicks = teamPicks.filter((p) => locked.has(p.pickIndex));
        }
        return teamPicks;
    };

    const getChampionName = (championIndex: string) => {
        if (!championIndex || championIndex === "") return "Empty";
        const index = parseInt(championIndex);
        return champions[index]?.name || "Unknown";
    };

    const getTeamColor = (team: "blue" | "red") => {
        return team === "blue" ? "text-darius-crimson" : "text-darius-ember";
    };

    const handleOpenModal = () => {
        if (isSpectator() || isLocked()) return;
        setIsOpen(true);
        setSelectedChampion(null);
        clearFilters();

        // Auto-select the captain's most recently locked pick/ban during live draft
        if (!props.draft?.completed) {
            setSelectedPickIndex(myLastLockedIndex());
        } else {
            setSelectedPickIndex(null);
        }
    };

    const handleSelectPick = (pickIndex: number) => {
        setSelectedPickIndex(pickIndex);
        setSelectedChampion(null);
    };

    const handleSelectChampion = (championIndex: string) => {
        setSelectedChampion(championIndex);
    };

    const handleSubmitRequest = () => {
        if (selectedPickIndex() === null || !selectedChampion()) return;
        props.onRequestChange(selectedPickIndex()!, selectedChampion()!);
        setIsOpen(false);
    };

    const handleApprove = () => {
        if (!props.pendingRequest) return;
        props.onApproveChange(props.pendingRequest.requestId);
    };

    const handleReject = () => {
        if (!props.pendingRequest) return;
        props.onRejectChange(props.pendingRequest.requestId);
    };

    const hasChangeableSlots = () => {
        return getMyBans().length > 0 || getMyPicks().length > 0;
    };

    onMount(() => {
        props.onOpenRef?.(handleOpenModal);
        props.onStateRef?.({ isLocked, timeRemaining, hasChangeableSlots });
    });

    return (
        <>
            {/* Request Change Button */}
            <Show when={!props.hideButton}>
                <Show when={!isSpectator() && !isLocked() && hasChangeableSlots()}>
                    <button
                        onClick={handleOpenModal}
                        class="w-full rounded border border-darius-crimson/40 bg-darius-crimson/10 px-3 py-1.5 text-sm font-medium text-darius-crimson transition-all hover:border-darius-crimson/60 hover:bg-darius-crimson/15"
                    >
                        <Show
                            when={timeRemaining() !== null && timeRemaining()! > 0}
                            fallback="Request Pick Change"
                        >
                            Request Pick Change ({formatTime(timeRemaining()!)})
                        </Show>
                    </button>
                </Show>
                <Show when={!isSpectator() && isLocked()}>
                    <div class="w-full rounded border border-darius-border/40 bg-darius-card-hover/30 px-3 py-1.5 text-center text-sm font-medium text-darius-text-secondary">
                        Picks Locked
                    </div>
                </Show>
            </Show>

            {/* Request Change Modal */}
            <Show when={isOpen()}>
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div class="relative w-full max-w-4xl rounded-lg border border-darius-border bg-darius-card p-8 pt-10">
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            class="absolute right-4 top-4 text-darius-text-secondary transition-colors"
                            aria-label="Close dialog"
                        >
                            <X size={20} />
                        </button>
                        <h2 class="mb-4 text-2xl font-bold text-darius-text-primary">
                            Request Pick Change
                        </h2>
                        <Show when={props.isCompetitive}>
                            <p class="mb-4 text-sm text-yellow-400">
                                Competitive Mode: The other team must approve this change
                            </p>
                        </Show>
                        <Show when={!props.isCompetitive}>
                            <p class="mb-4 text-sm text-darius-crimson">
                                Scrim Mode: Change will be applied immediately
                            </p>
                        </Show>

                        {/* Step 1: Select which ban or pick to change */}
                        <div class="mb-6">
                            <h3 class="mb-2 text-lg font-semibold text-darius-text-primary">
                                Step 1: Select ban or pick to change
                            </h3>

                            {/* Bans Section */}
                            <div class="mb-4">
                                <div class="mb-2 text-sm font-medium text-darius-text-secondary">
                                    Bans
                                </div>
                                <div class="grid grid-cols-5 gap-2">
                                    <For each={getMyBans()}>
                                        {(ban, idx) => (
                                            <button
                                                onClick={() =>
                                                    handleSelectPick(ban.pickIndex)
                                                }
                                                class={`rounded-lg border-2 p-3 text-center transition-all ${
                                                    selectedPickIndex() === ban.pickIndex
                                                        ? "border-darius-crimson bg-darius-crimson/20"
                                                        : "border-darius-border bg-darius-card-hover"
                                                }`}
                                            >
                                                <div class="text-xs text-darius-text-secondary">
                                                    Ban {idx() + 1}
                                                </div>
                                                <div class="mt-1 text-sm font-semibold text-darius-text-primary">
                                                    {getChampionName(ban.champion)}
                                                </div>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </div>

                            {/* Picks Section */}
                            <div>
                                <div class="mb-2 text-sm font-medium text-darius-text-secondary">
                                    Picks
                                </div>
                                <div class="grid grid-cols-5 gap-2">
                                    <For each={getMyPicks()}>
                                        {(pick, idx) => (
                                            <button
                                                onClick={() =>
                                                    handleSelectPick(pick.pickIndex)
                                                }
                                                class={`rounded-lg border-2 p-3 text-center transition-all ${
                                                    selectedPickIndex() === pick.pickIndex
                                                        ? "border-darius-crimson bg-darius-crimson/20"
                                                        : "border-darius-border bg-darius-card-hover"
                                                }`}
                                            >
                                                <div class="text-xs text-darius-text-secondary">
                                                    Pick {idx() + 1}
                                                </div>
                                                <div class="mt-1 text-sm font-semibold text-darius-text-primary">
                                                    {getChampionName(pick.champion)}
                                                </div>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </div>

                        {/* Step 2: Select new champion */}
                        <Show when={selectedPickIndex() !== null}>
                            <div class="mb-6">
                                <h3 class="mb-2 text-lg font-semibold text-darius-text-primary">
                                    Step 2: Select new champion
                                </h3>
                                <div class="mb-2">
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
                                        theme="crimson"
                                    />
                                </div>
                                <div class="max-h-72 overflow-y-auto rounded-lg border border-darius-border bg-darius-bg p-4">
                                    <div class="grid grid-cols-10 gap-1">
                                        <For each={filteredChampions()}>
                                            {({ item: champion, originalIndex }) => {
                                                const champIndex = () =>
                                                    String(originalIndex);
                                                const isAlreadyPicked = () =>
                                                    props.draft?.picks?.includes(
                                                        champIndex()
                                                    ) || false;
                                                const isDisabled = () =>
                                                    (
                                                        props.disabledChampions ?? []
                                                    ).includes(champIndex());
                                                const isSeriesRestricted = () =>
                                                    (
                                                        props.restrictedChampionGameMap ??
                                                        new Map()
                                                    ).has(champIndex());
                                                const restrictionInfo = () =>
                                                    (
                                                        props.restrictedChampionGameMap ??
                                                        new Map()
                                                    ).get(champIndex());
                                                const currentPickIndex = () =>
                                                    (props.draft?.picks ?? []).indexOf(
                                                        champIndex()
                                                    );
                                                const isUnavailable = () =>
                                                    isAlreadyPicked() ||
                                                    isDisabled() ||
                                                    isSeriesRestricted();
                                                const isSelected = () =>
                                                    selectedChampion() === champIndex();

                                                return (
                                                    <button
                                                        onClick={() =>
                                                            handleSelectChampion(
                                                                champIndex()
                                                            )
                                                        }
                                                        disabled={isUnavailable()}
                                                        title={
                                                            isDisabled()
                                                                ? `${champion.name} - Disabled For Series`
                                                                : isSeriesRestricted()
                                                                  ? `${champion.name} - ${restrictionInfo()?.label ?? "Restricted"} ${getDraftPositionText(restrictionInfo()?.pickIndex ?? 0)}`
                                                                  : isAlreadyPicked()
                                                                    ? `${champion.name} - Game ${currentGameNumber()} ${getDraftPositionText(currentPickIndex())}`
                                                                    : champion.name
                                                        }
                                                        class={`relative h-12 w-12 flex-shrink-0 overflow-hidden rounded border-2 transition-all ${
                                                            isSelected()
                                                                ? "border-darius-crimson"
                                                                : isDisabled()
                                                                  ? "cursor-not-allowed border-red-700"
                                                                  : isSeriesRestricted()
                                                                    ? `cursor-not-allowed ${gameBorderColors[restrictionInfo()?.colorIndex ?? 1] ?? "border-darius-border"}`
                                                                    : isAlreadyPicked()
                                                                      ? `cursor-not-allowed ${gameBorderColors[currentGameNumber()] ?? "border-darius-border"}`
                                                                      : "border-darius-border border-transparent"
                                                        }`}
                                                    >
                                                        <img
                                                            src={champion.img}
                                                            alt={champion.name}
                                                            class={`h-full w-full rounded ${isUnavailable() ? "opacity-40" : ""}`}
                                                        />
                                                        {/* Disabled overlay */}
                                                        <Show when={isDisabled()}>
                                                            <div class="absolute inset-0 flex items-center justify-center bg-red-900/40">
                                                                <X
                                                                    size={16}
                                                                    class="text-red-400"
                                                                />
                                                            </div>
                                                        </Show>
                                                        {/* Current game picked overlay badge */}
                                                        <Show
                                                            when={
                                                                isAlreadyPicked() &&
                                                                !isSeriesRestricted() &&
                                                                !isDisabled()
                                                            }
                                                        >
                                                            {(() => {
                                                                const parts =
                                                                    getDraftPositionParts(
                                                                        currentPickIndex()
                                                                    );
                                                                return (
                                                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-0.5 py-px text-[7px] font-bold leading-tight">
                                                                        <span
                                                                            class={
                                                                                gameTextColorsMuted[
                                                                                    currentGameNumber()
                                                                                ] ??
                                                                                "text-darius-text-secondary"
                                                                            }
                                                                        >
                                                                            G
                                                                            {currentGameNumber()}
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
                                                        {/* Series-restricted overlay badge */}
                                                        <Show when={isSeriesRestricted()}>
                                                            {(() => {
                                                                const info =
                                                                    restrictionInfo();
                                                                const parts =
                                                                    getDraftPositionParts(
                                                                        info?.pickIndex ??
                                                                            0
                                                                    );
                                                                const gameNum =
                                                                    info?.gameNumber ?? 1;
                                                                return (
                                                                    <div class="absolute bottom-0 left-0 right-0 flex justify-between bg-darius-bg/85 px-0.5 py-px text-[7px] font-bold leading-tight">
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

                        {/* Action Buttons */}
                        <div class="flex gap-3">
                            <button
                                onClick={() => setIsOpen(false)}
                                class="flex-1 rounded-lg border-2 border-darius-border bg-darius-card-hover px-4 py-3 font-semibold text-darius-text-secondary transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSubmitRequest}
                                disabled={
                                    selectedPickIndex() === null || !selectedChampion()
                                }
                                class="flex-1 rounded-lg border-2 border-darius-crimson/50 bg-darius-crimson/10 px-4 py-3 font-semibold text-darius-crimson transition-all hover:border-darius-crimson hover:bg-darius-crimson/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Submit Request
                            </button>
                        </div>
                    </div>
                </div>
            </Show>

            {/* Pending Request Approval Modal */}
            <Show when={props.pendingRequest}>
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div class="relative w-full max-w-md rounded-lg border border-darius-border bg-darius-card p-8 pt-10">
                        <button
                            type="button"
                            onClick={handleReject}
                            class="absolute right-4 top-4 text-darius-text-secondary transition-colors"
                            aria-label="Close dialog"
                        >
                            <X size={20} />
                        </button>
                        <div class="mb-6 text-center">
                            <div class="mb-4 text-6xl">🔄</div>
                            <h2 class="mb-2 text-2xl font-bold text-darius-text-primary">
                                Pick Change Request
                            </h2>
                            <p class="text-darius-text-secondary">
                                <span
                                    class={`font-semibold ${getTeamColor(props.pendingRequest?.team ?? "blue")}`}
                                >
                                    {getSideTeamName(
                                        props.pendingRequest?.team ?? "blue",
                                        props.draft?.blueSideTeam ?? 1,
                                        props.blueTeamName,
                                        props.redTeamName
                                    )}
                                </span>{" "}
                                wants to change a pick
                            </p>
                        </div>

                        <div class="mb-6 rounded-lg border border-darius-border bg-darius-bg p-4">
                            <div class="mb-2 text-center text-sm text-darius-text-secondary">
                                Requested Change:
                            </div>
                            <div class="flex items-center justify-center gap-3">
                                <div class="text-center">
                                    <div class="text-xs text-darius-text-secondary">
                                        Old
                                    </div>
                                    <div class="font-semibold text-red-400">
                                        {getChampionName(
                                            props.pendingRequest?.oldChampion ?? ""
                                        )}
                                    </div>
                                </div>
                                <div class="text-2xl text-darius-text-secondary">→</div>
                                <div class="text-center">
                                    <div class="text-xs text-darius-text-secondary">
                                        New
                                    </div>
                                    <div class="font-semibold text-darius-crimson">
                                        {getChampionName(
                                            props.pendingRequest?.newChampion ?? ""
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="flex gap-3">
                            <button
                                onClick={handleReject}
                                class="flex-1 rounded-lg border-2 border-red-600/50 bg-red-600/10 px-4 py-3 font-semibold text-red-400 transition-all hover:border-red-500 hover:bg-red-600/20"
                            >
                                Reject
                            </button>
                            <button
                                onClick={handleApprove}
                                class="flex-1 rounded-lg border-2 border-darius-crimson/50 bg-darius-crimson/10 px-4 py-3 font-semibold text-darius-crimson transition-all hover:border-darius-crimson hover:bg-darius-crimson/20"
                            >
                                Approve
                            </button>
                        </div>
                    </div>
                </div>
            </Show>
        </>
    );
};
