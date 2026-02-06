import { Component, Show, For, createSignal } from "solid-js";
import { draft } from "../utils/types";
import { champions, championCategories } from "../utils/constants";
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "./FilterBar";

interface PickChangeRequest {
    requestId: string;
    team: "blue" | "red";
    pickIndex: number;
    oldChampion: string;
    newChampion: string;
}

interface PickChangeModalProps {
    draft: draft;
    myRole: () => string | null;
    isCompetitive: boolean;
    pendingRequest: PickChangeRequest | null;
    onRequestChange: (pickIndex: number, newChampion: string) => void;
    onApproveChange: (requestId: string) => void;
    onRejectChange: (requestId: string) => void;
}

export const PickChangeModal: Component<PickChangeModalProps> = (props) => {
    const [isOpen, setIsOpen] = createSignal(false);
    const [selectedPickIndex, setSelectedPickIndex] = createSignal<number | null>(null);
    const [selectedChampion, setSelectedChampion] = createSignal<string | null>(null);

    const isSpectator = () => props.myRole() === "spectator";
    const myTeam = () => (props.myRole()?.includes("blue") ? "blue" : "red");

    // Champion filtering for Step 2
    const {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList,
        clearFilters
    } = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Get my team's bans for selection
    const getMyBans = () => {
        if (!props.draft) return [];
        const picks = props.draft.picks || [];
        const team = myTeam();

        if (team === "blue") {
            return picks
                .slice(0, 5)
                .map((champion, idx) => ({ champion, pickIndex: idx }));
        } else {
            return picks
                .slice(5, 10)
                .map((champion, idx) => ({ champion, pickIndex: idx + 5 }));
        }
    };

    // Get my team's picks for selection
    const getMyPicks = () => {
        if (!props.draft) return [];
        const picks = props.draft.picks || [];
        const team = myTeam();

        if (team === "blue") {
            return picks
                .slice(10, 15)
                .map((champion, idx) => ({ champion, pickIndex: idx + 10 }));
        } else {
            return picks
                .slice(15, 20)
                .map((champion, idx) => ({ champion, pickIndex: idx + 15 }));
        }
    };

    const getChampionName = (championIndex: string) => {
        if (!championIndex || championIndex === "") return "Empty";
        const index = parseInt(championIndex);
        return champions[index]?.name || "Unknown";
    };

    const getTeamColor = (team: "blue" | "red") => {
        return team === "blue" ? "text-blue-400" : "text-red-400";
    };

    const handleOpenModal = () => {
        if (isSpectator() || !props.draft?.completed) return;
        setIsOpen(true);
        setSelectedPickIndex(null);
        setSelectedChampion(null);
        clearFilters();
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

    return (
        <>
            {/* Request Change Button */}
            <Show when={props.draft?.completed && !isSpectator()}>
                <button
                    onClick={handleOpenModal}
                    class="w-full rounded border border-orange-600/40 bg-orange-600/10 px-3 py-1.5 text-sm font-medium text-orange-400 transition-all hover:border-orange-500/60 hover:bg-orange-600/15"
                >
                    Request Pick Change
                </button>
            </Show>

            {/* Request Change Modal */}
            <Show when={isOpen()}>
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div class="w-full max-w-4xl rounded-lg border border-slate-700 bg-slate-800 p-8">
                        <h2 class="mb-4 text-2xl font-bold text-slate-50">
                            Request Pick Change
                        </h2>
                        <Show when={props.isCompetitive}>
                            <p class="mb-4 text-sm text-yellow-400">
                                Competitive Mode: The other team must approve this change
                            </p>
                        </Show>
                        <Show when={!props.isCompetitive}>
                            <p class="mb-4 text-sm text-orange-400">
                                Scrim Mode: Change will be applied immediately
                            </p>
                        </Show>

                        {/* Step 1: Select which ban or pick to change */}
                        <div class="mb-6">
                            <h3 class="mb-2 text-lg font-semibold text-slate-200">
                                Step 1: Select ban or pick to change
                            </h3>

                            {/* Bans Section */}
                            <div class="mb-4">
                                <div class="mb-2 text-sm font-medium text-slate-400">
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
                                                        ? "border-orange-500 bg-orange-600/20"
                                                        : "border-slate-600 bg-slate-700 hover:border-slate-500"
                                                }`}
                                            >
                                                <div class="text-xs text-slate-400">
                                                    Ban {idx() + 1}
                                                </div>
                                                <div class="mt-1 text-sm font-semibold text-slate-200">
                                                    {getChampionName(ban.champion)}
                                                </div>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </div>

                            {/* Picks Section */}
                            <div>
                                <div class="mb-2 text-sm font-medium text-slate-400">
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
                                                        ? "border-orange-500 bg-orange-600/20"
                                                        : "border-slate-600 bg-slate-700 hover:border-slate-500"
                                                }`}
                                            >
                                                <div class="text-xs text-slate-400">
                                                    Pick {idx() + 1}
                                                </div>
                                                <div class="mt-1 text-sm font-semibold text-slate-200">
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
                                <h3 class="mb-2 text-lg font-semibold text-slate-200">
                                    Step 2: Select new champion
                                </h3>
                                <div class="mb-2">
                                    <FilterBar
                                        searchText={searchText}
                                        onSearchChange={setSearchText}
                                        selectedCategory={selectedCategory}
                                        onCategoryChange={setSelectedCategory}
                                        categories={championCategoryList}
                                        searchPlaceholder="Search champions..."
                                        categoryPlaceholder="Role"
                                    />
                                </div>
                                <div class="max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4">
                                    <div class="grid grid-cols-10 gap-1">
                                        <For each={filteredChampions()}>
                                            {({ item: champion, originalIndex }) => {
                                                const champIndex = () =>
                                                    String(originalIndex);
                                                const isAlreadyPicked = () =>
                                                    props.draft?.picks?.includes(
                                                        champIndex()
                                                    ) || false;
                                                const isSelected = () =>
                                                    selectedChampion() === champIndex();

                                                return (
                                                    <button
                                                        onClick={() =>
                                                            handleSelectChampion(
                                                                champIndex()
                                                            )
                                                        }
                                                        disabled={isAlreadyPicked()}
                                                        title={champion.name}
                                                        class={`h-12 w-12 flex-shrink-0 rounded border-2 transition-all ${
                                                            isSelected()
                                                                ? "border-orange-500"
                                                                : isAlreadyPicked()
                                                                  ? "cursor-not-allowed border-transparent opacity-30"
                                                                  : "border-transparent hover:border-slate-500"
                                                        }`}
                                                    >
                                                        <img
                                                            src={champion.img}
                                                            alt={champion.name}
                                                            class={`h-full w-full rounded ${isAlreadyPicked() ? "grayscale" : ""}`}
                                                        />
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
                                class="flex-1 rounded-lg border-2 border-slate-600 bg-slate-700 px-4 py-3 font-semibold text-slate-300 transition-all hover:border-slate-500"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSubmitRequest}
                                disabled={
                                    selectedPickIndex() === null || !selectedChampion()
                                }
                                class="flex-1 rounded-lg border-2 border-orange-600/50 bg-orange-600/10 px-4 py-3 font-semibold text-orange-400 transition-all hover:border-orange-500 hover:bg-orange-600/20 disabled:cursor-not-allowed disabled:opacity-50"
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
                    <div class="w-full max-w-md rounded-lg border border-slate-700 bg-slate-800 p-8">
                        <div class="mb-6 text-center">
                            <div class="mb-4 text-6xl">🔄</div>
                            <h2 class="mb-2 text-2xl font-bold text-slate-50">
                                Pick Change Request
                            </h2>
                            <p class="text-slate-400">
                                <span
                                    class={`font-semibold ${getTeamColor(props.pendingRequest?.team ?? "blue")}`}
                                >
                                    {props.pendingRequest?.team === "blue"
                                        ? "Blue Team"
                                        : "Red Team"}
                                </span>{" "}
                                wants to change a pick
                            </p>
                        </div>

                        <div class="mb-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
                            <div class="mb-2 text-center text-sm text-slate-400">
                                Requested Change:
                            </div>
                            <div class="flex items-center justify-center gap-3">
                                <div class="text-center">
                                    <div class="text-xs text-slate-500">Old</div>
                                    <div class="font-semibold text-red-400">
                                        {getChampionName(
                                            props.pendingRequest?.oldChampion ?? ""
                                        )}
                                    </div>
                                </div>
                                <div class="text-2xl text-slate-500">→</div>
                                <div class="text-center">
                                    <div class="text-xs text-slate-500">New</div>
                                    <div class="font-semibold text-orange-400">
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
                                class="flex-1 rounded-lg border-2 border-orange-600/50 bg-orange-600/10 px-4 py-3 font-semibold text-orange-400 transition-all hover:border-orange-500 hover:bg-orange-600/20"
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
