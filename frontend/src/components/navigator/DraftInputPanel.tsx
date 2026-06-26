import { Component, For, Show, createMemo } from "solid-js";
import { Undo2 } from "lucide-solid";
import { ChampionPortrait } from "../ChampionPortrait";
import { FilterBar } from "../FilterBar";
import { RoleFilter } from "../RoleFilter";
import { useMultiFilterableItems } from "../../hooks/useFilterableItems";
import { NavigatorEventData, useNavigatorContext } from "../../contexts/NavigatorContext";
import { championCategories, champions, resolveChampion } from "../../utils/constants";
import { getPickerState, type PickerState } from "../../utils/navigatorPool";
import { TURN_SEQUENCE, TurnInfo as BaseTurnInfo } from "../../utils/turnSequence";

type DraftSide = "blue" | "red";
type DraftTurnType = "ban" | "pick";
type DraftPhase = "ban1" | "pick1" | "ban2" | "pick2";

interface TurnInfo extends BaseTurnInfo {
    label: string;
}

interface DraftSlotState {
    turn: TurnInfo;
    turnIndex: number;
    event: NavigatorEventData | undefined;
}

const PANEL_TURN_SEQUENCE: TurnInfo[] = TURN_SEQUENCE.map((turn, index) => {
    const sideLabel = turn.side === "blue" ? "Blue" : "Red";
    const turnType: DraftTurnType = turn.type;
    const typeLabel = turnType === "ban" ? "Ban" : "Pick";
    const countOnSide = TURN_SEQUENCE.slice(0, index + 1).filter(
        (t) => t.side === turn.side && t.type === turn.type
    ).length;
    return { ...turn, label: `${sideLabel} ${typeLabel} ${countOnSide}` };
});

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
                        <ChampionPortrait
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

interface DraftInputPanelProps {
    mode?: "active" | "review";
    reviewEvents?: NavigatorEventData[];
    crossGameExcluded?: Map<string, number>;
}

const DraftInputPanel: Component<DraftInputPanelProps> = (props) => {
    const { navigatorContext, emitBan, emitPickStep, emitUndo } = useNavigatorContext();

    const resolvedMode = () => props.mode ?? "active";

    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    const filteredChampions = createMemo(() => filterState.filteredItems());

    const draftEvents = createMemo(() => {
        if (resolvedMode() === "review") {
            return (props.reviewEvents ?? []).filter(
                (event) => event.event_type === "ban" || event.event_type === "pick"
            );
        }
        return navigatorContext().events.filter(
            (event) => event.event_type === "ban" || event.event_type === "pick"
        );
    });

    const turnIndex = createMemo(() => draftEvents().length);
    const currentTurn = createMemo(() => PANEL_TURN_SEQUENCE[turnIndex()] ?? null);
    const usedChampionIds = createMemo(() => {
        const usedIds = new Set<string>();

        for (const event of draftEvents()) {
            usedIds.add(event.champion_id);
        }

        return usedIds;
    });

    const pickerStateFor = (championId: string): PickerState => {
        const session = navigatorContext().session;
        if (!session) return "neutral";
        return getPickerState(
            championId,
            currentTurn()?.side ?? null,
            session.blue_pool,
            session.red_pool,
            usedChampionIds()
        );
    };

    const crossGameExcludedFor = (championId: string): number | null => {
        return props.crossGameExcluded?.get(championId) ?? null;
    };

    const slotStates = createMemo<DraftSlotState[]>(() =>
        PANEL_TURN_SEQUENCE.map((turn, index) => ({
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
            emitPickStep(draftId, [championId], turnIndex());
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
                            {draftEvents().length} / {PANEL_TURN_SEQUENCE.length}
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

                <Show when={resolvedMode() === "active"}>
                    <section class="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-700/50 bg-slate-900 p-4">
                        <div class="text-sm font-semibold text-slate-300">
                            Champion Picker
                        </div>
                        <div class="mt-3">
                            <FilterBar
                                searchText={filterState.searchText}
                                onSearchChange={filterState.setSearchText}
                                searchPlaceholder="Search champions..."
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
                                <For each={filteredChampions()}>
                                    {({ item: champion }) => {
                                        const state = () => pickerStateFor(champion.id);
                                        const excludedGame = () =>
                                            crossGameExcludedFor(champion.id);
                                        const isDisabled = () =>
                                            state() === "picked" ||
                                            excludedGame() !== null ||
                                            !currentTurn() ||
                                            !navigatorContext().draft?.id;
                                        const tooltip = () => {
                                            const gn = excludedGame();
                                            if (gn === null) return champion.name;
                                            const mode =
                                                navigatorContext().session?.draft_mode ===
                                                "ironman"
                                                    ? "ironman"
                                                    : "fearless";
                                            return `${champion.name} — picked in Game ${gn} (${mode})`;
                                        };

                                        return (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleChampionSelect(champion.id)
                                                }
                                                disabled={isDisabled()}
                                                title={tooltip()}
                                                class={`relative overflow-hidden rounded-full border-2 bg-slate-800 transition-all ${
                                                    excludedGame() !== null
                                                        ? "cursor-not-allowed border-slate-700 opacity-30"
                                                        : state() === "picked"
                                                          ? "cursor-not-allowed border-slate-700 opacity-30"
                                                          : state() === "own-team"
                                                            ? currentTurn()?.side ===
                                                              "blue"
                                                                ? "border-blue-400 hover:-translate-y-0.5"
                                                                : "border-red-400 hover:-translate-y-0.5"
                                                            : state() === "other-team"
                                                              ? currentTurn()?.side ===
                                                                "blue"
                                                                  ? "border-red-400/60 hover:-translate-y-0.5"
                                                                  : "border-blue-400/60 hover:-translate-y-0.5"
                                                              : state() === "shared"
                                                                ? "border-purple-400 hover:-translate-y-0.5"
                                                                : "border-slate-600 hover:-translate-y-0.5 hover:border-slate-400"
                                                }`}
                                            >
                                                <ChampionPortrait
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
                </Show>

                <Show when={resolvedMode() === "active"}>
                    <button
                        type="button"
                        onClick={handleUndo}
                        disabled={
                            draftEvents().length === 0 || !navigatorContext().draft?.id
                        }
                        class="mt-auto flex items-center justify-center gap-2 rounded-lg border border-slate-700/50 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <Undo2 size={16} />
                        <span>Undo Last</span>
                    </button>
                </Show>
            </div>
        </div>
    );
};

export default DraftInputPanel;
