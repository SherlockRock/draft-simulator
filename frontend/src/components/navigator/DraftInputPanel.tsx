import { Component, For, Show, createMemo } from "solid-js";
import { Undo2 } from "lucide-solid";
import { FilterBar } from "../FilterBar";
import { RoleFilter } from "../RoleFilter";
import { useMultiFilterableItems } from "../../hooks/useFilterableItems";
import { NavigatorEventData, useNavigatorContext } from "../../contexts/NavigatorContext";
import { championCategories, champions, resolveChampion } from "../../utils/constants";

type DraftSide = "blue" | "red";
type DraftTurnType = "ban" | "pick";
type DraftPhase = "ban1" | "pick1" | "ban2" | "pick2";

interface TurnInfo {
    side: DraftSide;
    type: DraftTurnType;
    phase: DraftPhase;
    label: string;
}

interface DraftSlotState {
    turn: TurnInfo;
    turnIndex: number;
    event: NavigatorEventData | undefined;
}

const TURN_SEQUENCE: TurnInfo[] = [
    { side: "blue", type: "ban", phase: "ban1", label: "Blue Ban 1" },
    { side: "red", type: "ban", phase: "ban1", label: "Red Ban 1" },
    { side: "blue", type: "ban", phase: "ban1", label: "Blue Ban 2" },
    { side: "red", type: "ban", phase: "ban1", label: "Red Ban 2" },
    { side: "blue", type: "ban", phase: "ban1", label: "Blue Ban 3" },
    { side: "red", type: "ban", phase: "ban1", label: "Red Ban 3" },
    { side: "blue", type: "pick", phase: "pick1", label: "Blue Pick 1" },
    { side: "red", type: "pick", phase: "pick1", label: "Red Pick 1" },
    { side: "red", type: "pick", phase: "pick1", label: "Red Pick 2" },
    { side: "blue", type: "pick", phase: "pick1", label: "Blue Pick 2" },
    { side: "blue", type: "pick", phase: "pick1", label: "Blue Pick 3" },
    { side: "red", type: "pick", phase: "pick1", label: "Red Pick 3" },
    { side: "red", type: "ban", phase: "ban2", label: "Red Ban 4" },
    { side: "blue", type: "ban", phase: "ban2", label: "Blue Ban 4" },
    { side: "red", type: "ban", phase: "ban2", label: "Red Ban 5" },
    { side: "blue", type: "ban", phase: "ban2", label: "Blue Ban 5" },
    { side: "red", type: "pick", phase: "pick2", label: "Red Pick 4" },
    { side: "blue", type: "pick", phase: "pick2", label: "Blue Pick 4" },
    { side: "blue", type: "pick", phase: "pick2", label: "Blue Pick 5" },
    { side: "red", type: "pick", phase: "pick2", label: "Red Pick 5" }
];

const PHASE_LABELS: Record<DraftPhase, string> = {
    ban1: "Ban Phase 1",
    pick1: "Pick Phase 1",
    ban2: "Ban Phase 2",
    pick2: "Pick Phase 2"
};

const sideBorderClass: Record<DraftSide, string> = {
    blue: "border-blue-500",
    red: "border-red-500"
};

const sideTextClass: Record<DraftSide, string> = {
    blue: "text-blue-400",
    red: "text-red-400"
};

const SlotCircle: Component<{
    slot: DraftSlotState;
    isActive: boolean;
    showBanSlash?: boolean;
}> = (props) => {
    const champion = createMemo(() =>
        props.slot.event ? resolveChampion(props.slot.event.champion_id) : undefined
    );

    return (
        <div
            class={`relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border-2 bg-slate-900 transition-all ${
                props.isActive
                    ? `animate-pulse ${sideBorderClass[props.slot.turn.side]} ring-4 ${
                          props.slot.turn.side === "blue"
                              ? "ring-blue-500/30"
                              : "ring-red-500/30"
                      }`
                    : props.slot.event
                      ? sideBorderClass[props.slot.turn.side]
                      : `border-dashed ${sideBorderClass[props.slot.turn.side]}`
            }`}
            title={props.slot.turn.label}
        >
            <Show
                when={champion()}
                fallback={
                    <div class="h-10 w-10 rounded-full border border-slate-700/60" />
                }
            >
                {(resolvedChampion) => (
                    <>
                        <img
                            src={resolvedChampion().img}
                            alt={resolvedChampion().name}
                            class="h-full w-full object-cover"
                        />
                        <Show when={props.showBanSlash}>
                            <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
                                <div class="h-[150%] w-1 -rotate-45 bg-slate-100/70" />
                            </div>
                        </Show>
                    </>
                )}
            </Show>
        </div>
    );
};

const DraftInputPanel: Component = () => {
    const { navigatorContext, emitBan, emitPick, emitUndo } = useNavigatorContext();

    const displayPoolChampionIds = createMemo(() => {
        const displayPool = navigatorContext().session?.display_pool ?? [];
        return new Set(displayPool);
    });

    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    const filteredDisplayPoolChampions = createMemo(() =>
        filterState
            .filteredItems()
            .filter(({ item }) => displayPoolChampionIds().has(item.id))
    );

    const draftEvents = createMemo(() =>
        navigatorContext().events.filter(
            (event) => event.event_type === "ban" || event.event_type === "pick"
        )
    );

    const turnIndex = createMemo(() => draftEvents().length);
    const currentTurn = createMemo(() => TURN_SEQUENCE[turnIndex()] ?? null);
    const usedChampionIds = createMemo(() => {
        const usedIds = new Set<string>();

        for (const event of draftEvents()) {
            usedIds.add(event.champion_id);
        }

        return usedIds;
    });

    const slotStates = createMemo<DraftSlotState[]>(() =>
        TURN_SEQUENCE.map((turn, index) => ({
            turn,
            turnIndex: index,
            event: draftEvents()[index]
        }))
    );

    const blueBanPhaseOne = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.phase === "ban1" && slot.turn.side === "blue"
        )
    );
    const redBanPhaseOne = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.phase === "ban1" && slot.turn.side === "red"
        )
    );
    const blueBanPhaseTwo = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.phase === "ban2" && slot.turn.side === "blue"
        )
    );
    const redBanPhaseTwo = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.phase === "ban2" && slot.turn.side === "red"
        )
    );
    const bluePickSlots = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.type === "pick" && slot.turn.side === "blue"
        )
    );
    const redPickSlots = createMemo(() =>
        slotStates().filter(
            (slot) => slot.turn.type === "pick" && slot.turn.side === "red"
        )
    );

    const phaseHeading = createMemo(() => {
        const turn = currentTurn();
        return turn ? `${PHASE_LABELS[turn.phase]} — ${turn.label}` : "Draft Complete";
    });

    const handleChampionSelect = (championId: string) => {
        const draftId = navigatorContext().draft?.id;
        const turn = currentTurn();

        if (!draftId || !turn || usedChampionIds().has(championId)) {
            return;
        }

        if (turn.type === "pick") {
            emitPick(draftId, championId, turnIndex());
            return;
        }

        emitBan(draftId, championId, turnIndex());
    };

    const handleUndo = () => {
        const draftId = navigatorContext().draft?.id;

        if (draftId) {
            emitUndo(draftId);
        }
    };

    return (
        <div class="flex h-full flex-col bg-slate-800">
            <div class="border-b border-slate-700/50 px-4 py-4">
                <div class="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Draft Navigator
                </div>
                <div class="mt-2 text-sm font-semibold text-slate-100">
                    {phaseHeading()}
                </div>
                <Show when={currentTurn()}>
                    {(turn) => (
                        <div class="mt-1 text-xs text-slate-400">
                            <span class={sideTextClass[turn().side]}>{turn().side}</span>
                            <span class="text-slate-500"> on the clock</span>
                        </div>
                    )}
                </Show>
            </div>

            <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
                <section class="rounded-xl border border-slate-700/50 bg-slate-900 p-4">
                    <div class="flex items-center justify-between">
                        <h2 class="text-sm font-semibold text-slate-300">Draft State</h2>
                        <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">
                            {draftEvents().length} / {TURN_SEQUENCE.length}
                        </div>
                    </div>

                    <div class="mt-4 space-y-4">
                        <div class="space-y-3">
                            <div class="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                                Bans
                            </div>
                            <div class="space-y-3 rounded-lg border border-slate-700/50 bg-slate-800/80 p-3">
                                <div class="grid grid-cols-3 gap-2">
                                    <For each={blueBanPhaseOne()}>
                                        {(slot) => (
                                            <SlotCircle
                                                slot={slot}
                                                isActive={slot.turnIndex === turnIndex()}
                                                showBanSlash
                                            />
                                        )}
                                    </For>
                                </div>
                                <div class="grid grid-cols-3 gap-2">
                                    <For each={redBanPhaseOne()}>
                                        {(slot) => (
                                            <SlotCircle
                                                slot={slot}
                                                isActive={slot.turnIndex === turnIndex()}
                                                showBanSlash
                                            />
                                        )}
                                    </For>
                                </div>
                            </div>
                            <div class="space-y-3 rounded-lg border border-slate-700/50 bg-slate-800/80 p-3">
                                <div class="grid grid-cols-2 gap-2">
                                    <For each={blueBanPhaseTwo()}>
                                        {(slot) => (
                                            <SlotCircle
                                                slot={slot}
                                                isActive={slot.turnIndex === turnIndex()}
                                                showBanSlash
                                            />
                                        )}
                                    </For>
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <For each={redBanPhaseTwo()}>
                                        {(slot) => (
                                            <SlotCircle
                                                slot={slot}
                                                isActive={slot.turnIndex === turnIndex()}
                                                showBanSlash
                                            />
                                        )}
                                    </For>
                                </div>
                            </div>
                        </div>

                        <div class="space-y-3">
                            <div class="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                                Picks
                            </div>
                            <div class="grid grid-cols-2 gap-3 rounded-lg border border-slate-700/50 bg-slate-800/80 p-3">
                                <div class="space-y-2">
                                    <div class="text-xs font-medium uppercase tracking-[0.16em] text-blue-400">
                                        Blue
                                    </div>
                                    <div class="flex flex-col gap-2">
                                        <For each={bluePickSlots()}>
                                            {(slot) => (
                                                <SlotCircle
                                                    slot={slot}
                                                    isActive={
                                                        slot.turnIndex === turnIndex()
                                                    }
                                                />
                                            )}
                                        </For>
                                    </div>
                                </div>
                                <div class="space-y-2">
                                    <div class="text-xs font-medium uppercase tracking-[0.16em] text-red-400">
                                        Red
                                    </div>
                                    <div class="flex flex-col gap-2">
                                        <For each={redPickSlots()}>
                                            {(slot) => (
                                                <SlotCircle
                                                    slot={slot}
                                                    isActive={
                                                        slot.turnIndex === turnIndex()
                                                    }
                                                />
                                            )}
                                        </For>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-700/50 bg-slate-900 p-4">
                    <div class="text-sm font-semibold text-slate-300">
                        Champion Picker
                    </div>
                    <div class="mt-3">
                        <FilterBar
                            searchText={filterState.searchText}
                            onSearchChange={filterState.setSearchText}
                            searchPlaceholder="Search display pool..."
                        />
                        <RoleFilter
                            categories={filterState.categories}
                            selectedCategories={filterState.selectedCategories}
                            onToggle={filterState.toggleCategory}
                            onClearAll={filterState.clearCategories}
                            theme="neutral"
                        />
                    </div>

                    <div class="mt-4 flex-1 overflow-y-auto">
                        <div class="grid grid-cols-6 gap-2">
                            <For each={filteredDisplayPoolChampions()}>
                                {({ item: champion }) => {
                                    const isUsed = () =>
                                        usedChampionIds().has(champion.id);
                                    const isDisabled = () =>
                                        isUsed() ||
                                        !currentTurn() ||
                                        !navigatorContext().draft?.id;

                                    return (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                handleChampionSelect(champion.id)
                                            }
                                            disabled={isDisabled()}
                                            title={champion.name}
                                            class={`relative overflow-hidden rounded-full border-2 bg-slate-800 transition-all ${
                                                isDisabled()
                                                    ? "cursor-not-allowed border-slate-700 opacity-30"
                                                    : "border-slate-600 hover:-translate-y-0.5 hover:border-slate-400"
                                            }`}
                                        >
                                            <img
                                                src={champion.img}
                                                alt={champion.name}
                                                class="h-10 w-10 object-cover"
                                            />
                                        </button>
                                    );
                                }}
                            </For>
                        </div>
                    </div>
                </section>

                <button
                    type="button"
                    onClick={handleUndo}
                    disabled={draftEvents().length === 0 || !navigatorContext().draft?.id}
                    class="mt-auto flex items-center justify-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <Undo2 size={16} />
                    <span>Undo Last</span>
                </button>
            </div>
        </div>
    );
};

export default DraftInputPanel;
