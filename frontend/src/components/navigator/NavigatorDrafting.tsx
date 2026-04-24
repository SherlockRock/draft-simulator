import { Component, Show, createEffect, createMemo, createSignal } from "solid-js";
import toast from "solid-toast";
import ChampionPicker, { type ChampionColorState } from "../ChampionPicker";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { getPickerState } from "../../utils/navigatorPool";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import { eventsToConfirmedTurns } from "../../utils/treeReconcile";
import DraftInputPanel from "./DraftInputPanel";
import DecisionTree from "./DecisionTree";
import ScenarioLanes from "./ScenarioLanes";
import { SeriesTabStrip } from "./SeriesTabStrip";
import { BetweenGamesPanel } from "./BetweenGamesPanel";

const NavigatorDrafting: Component = () => {
    const {
        joinSession,
        navigatorContext,
        syntheticTree,
        isComputing: isComputingFromContext,
        selectedScenarioIndex,
        setSelectedScenarioIndex,
        panRequest,
        emitPick,
        emitBan,
        swapChampion,
        createBranch,
        viewingGameNumber,
        viewGame,
        startNextGame,
        updateSessionPools
    } = useNavigatorContext();
    const [highlightedTreePath, setHighlightedTreePath] = createSignal<number[] | null>(
        null
    );
    const [swapTarget, setSwapTarget] = createSignal<{
        path: number[];
        oldChampionId: string;
        contextLabel: string;
    } | null>(null);
    const [branchTarget, setBranchTarget] = createSignal<{
        pathToParent: number[];
        contextLabel: string;
    } | null>(null);

    const session = () => navigatorContext().session;
    const activeDraft = () => navigatorContext().draft;
    const completedGames = () => navigatorContext().completedGames;

    const viewingArchive = createMemo(() => {
        const gn = viewingGameNumber();
        if (gn === null) return null;
        return completedGames().find((c) => c.draft.game_number === gn) ?? null;
    });

    const showBetweenGamesPanel = createMemo(() => {
        if (viewingGameNumber() !== null) return false;
        const draft = activeDraft();
        if (!draft) return false;
        return draft.status === "completed";
    });

    const isSeriesComplete = createMemo(() => {
        const s = session();
        const draft = activeDraft();
        if (!s || !draft) return false;
        return draft.status === "completed" && draft.game_number >= s.series_length;
    });

    const crossGameExcluded = createMemo(() => {
        const map = new Map<string, number>();
        const s = session();
        if (!s || s.draft_mode === "standard") return map;
        const includeBans = s.draft_mode === "ironman";
        for (const archive of completedGames()) {
            for (const event of archive.events) {
                if (
                    event.event_type === "pick" ||
                    (includeBans && event.event_type === "ban")
                ) {
                    if (!map.has(event.champion_id)) {
                        map.set(event.champion_id, archive.draft.game_number);
                    }
                }
            }
        }
        return map;
    });

    const treeData = createMemo(() => {
        const archive = viewingArchive();
        if (archive) return archive.snapshot?.tree ?? null;
        return syntheticTree();
    });

    const scenarios = createMemo(() => {
        const archive = viewingArchive();
        if (archive) return archive.snapshot?.scenarios ?? [];
        return navigatorContext().snapshot?.scenarios ?? [];
    });

    const confirmedDepth = createMemo(() => {
        const archive = viewingArchive();
        const events = archive ? archive.events : navigatorContext().events;
        return eventsToConfirmedTurns(events).length + 1;
    });

    const isStale = createMemo(
        () =>
            viewingGameNumber() === null &&
            navigatorContext().snapshot === null &&
            navigatorContext().events.length > 0 &&
            !isComputingFromContext()
    );
    const activeSessionId = createMemo(() => navigatorContext().session?.id ?? null);
    const usedChampionIdSet = createMemo<Set<string>>(() => {
        const ids = new Set<string>();
        for (const event of navigatorContext().events) {
            if (event.event_type === "ban" || event.event_type === "pick") {
                ids.add(event.champion_id);
            }
        }
        return ids;
    });

    const swapColoringFor = (championId: string): ChampionColorState => {
        const session = navigatorContext().session;
        if (!session) return "neutral";
        const turnIndex = swapTarget()?.path.length ?? 0;
        const turnInfo = TURN_SEQUENCE[turnIndex - 1];
        return getPickerState(
            championId,
            turnInfo?.side ?? null,
            session.blue_pool,
            session.red_pool,
            usedChampionIdSet()
        );
    };

    const branchColoringFor = (championId: string): ChampionColorState => {
        const session = navigatorContext().session;
        if (!session) return "neutral";
        const turnIndex = (branchTarget()?.pathToParent.length ?? 0) + 1;
        const turnInfo = TURN_SEQUENCE[turnIndex - 1];
        return getPickerState(
            championId,
            turnInfo?.side ?? null,
            session.blue_pool,
            session.red_pool,
            usedChampionIdSet()
        );
    };

    createEffect(() => {
        const nextScenarios = scenarios();
        const selectedIndex = selectedScenarioIndex();

        if (nextScenarios.length === 0) {
            setSelectedScenarioIndex(null);
            setHighlightedTreePath(null);
        } else if (selectedIndex !== null && selectedIndex >= nextScenarios.length) {
            setSelectedScenarioIndex(null);
        } else if (selectedIndex !== null) {
            const selected = nextScenarios[selectedIndex];
            if (selected?.treePath) {
                setHighlightedTreePath(selected.treePath);
            }
        }
    });

    const handleNodeClick = (nodePath: number[]) => {
        const matchIdx = scenarios().findIndex((scenario) =>
            nodePath.every((value, index) => scenario.treePath[index] === value)
        );

        setHighlightedTreePath(nodePath);
        setSelectedScenarioIndex(matchIdx >= 0 ? matchIdx : null);
    };

    const handleRetry = () => {
        const sessionId = activeSessionId();

        if (sessionId) {
            joinSession(sessionId);
        }
    };

    const handlePromoteToScenario = (_path: number[]) => {
        toast("Promote-to-scenario coming soon.", { icon: "ℹ️" });
    };

    const handleConfirmProjectedPick = (path: number[]) => {
        const synthetic = syntheticTree();
        if (!synthetic) return;

        let current: NavigatorTreeNode | null = synthetic;
        for (const index of path) {
            if (!current || !current.children[index]) return;
            current = current.children[index];
        }
        if (!current) return;

        const draftId = navigatorContext().draft?.id;
        if (!draftId) return;

        const championIds = current.championIds;
        if (championIds.length === 0) return;

        const turnIndex = navigatorContext().events.filter(
            (event) => event.event_type === "ban" || event.event_type === "pick"
        ).length;

        if (current.actionType === "pick") {
            // Pair-pick nodes carry two champions across two adjacent slots; emit both.
            emitPick(draftId, championIds[0], turnIndex);
            if (championIds.length > 1) {
                emitPick(draftId, championIds[1], turnIndex + 1);
            }
        } else {
            emitBan(draftId, championIds[0], turnIndex);
        }
    };

    const handleOpenSwap = (path: number[]) => {
        const synthetic = syntheticTree();
        if (!synthetic) return;

        let node: NavigatorTreeNode | null = synthetic;
        for (const index of path) {
            if (!node || !node.children[index]) return;
            node = node.children[index];
        }
        if (!node) return;

        const oldChampionId = node.championIds[0];
        if (!oldChampionId) return;

        const turnInfo = TURN_SEQUENCE[path.length - 1];
        const label = turnInfo
            ? `${turnInfo.side.toUpperCase()} ${turnInfo.type.toUpperCase()} ${path.length}`
            : `TURN ${path.length}`;

        setSwapTarget({
            path,
            oldChampionId,
            contextLabel: label
        });
    };

    const handleOpenBranch = (path: number[]) => {
        const turnInfo = TURN_SEQUENCE[path.length - 1];
        const label = turnInfo
            ? `${turnInfo.side.toUpperCase()} ${turnInfo.type.toUpperCase()} ${path.length}`
            : `TURN ${path.length}`;
        setBranchTarget({
            pathToParent: path.slice(0, -1),
            contextLabel: label
        });
    };

    return (
        <>
            <div class="flex h-full w-full flex-col">
                <Show when={session()}>
                    {(s) => (
                        <SeriesTabStrip
                            session={s()}
                            activeDraft={activeDraft()}
                            completedGames={completedGames()}
                            viewingGameNumber={viewingGameNumber()}
                            onViewGame={viewGame}
                        />
                    )}
                </Show>

                <div
                    class="grid min-h-0 w-full flex-1"
                    style={{
                        "grid-template-columns": "300px 1fr",
                        "grid-template-rows": "1fr 280px"
                    }}
                >
                    <div class="row-span-2 overflow-y-auto border-r border-slate-700/50">
                        <Show
                            when={showBetweenGamesPanel()}
                            fallback={
                                <DraftInputPanel
                                    mode={
                                        viewingGameNumber() !== null ? "review" : "active"
                                    }
                                    reviewEvents={viewingArchive()?.events}
                                    crossGameExcluded={crossGameExcluded()}
                                />
                            }
                        >
                            <Show when={session() && activeDraft()}>
                                {(_) => {
                                    const s = session();
                                    const d = activeDraft();
                                    if (!s || !d) return null;
                                    return (
                                        <BetweenGamesPanel
                                            session={s}
                                            completedDraft={d}
                                            isSeriesComplete={isSeriesComplete()}
                                            onStartNextGame={(override) =>
                                                startNextGame(override)
                                            }
                                            onSavePools={(blue, red) =>
                                                updateSessionPools(blue, red)
                                            }
                                        />
                                    );
                                }}
                            </Show>
                        </Show>
                    </div>

                    <div class="relative min-h-0 bg-slate-900/20">
                        <DecisionTree
                            treeData={treeData()}
                            isComputing={
                                viewingGameNumber() === null
                                    ? isComputingFromContext()
                                    : false
                            }
                            highlightedPath={highlightedTreePath()}
                            confirmedDepth={confirmedDepth()}
                            scenarioPaths={scenarios().map((scenario, index) => ({
                                path: scenario.treePath,
                                tier:
                                    selectedScenarioIndex() === index
                                        ? "selected"
                                        : "unselected"
                            }))}
                            panRequest={panRequest()}
                            onNodeClick={handleNodeClick}
                            onPromoteToScenario={handlePromoteToScenario}
                            onConfirmProjectedPick={handleConfirmProjectedPick}
                            onOpenSwap={handleOpenSwap}
                            onOpenBranch={handleOpenBranch}
                        />

                        <Show when={isStale()}>
                            <div class="pointer-events-none absolute right-4 top-4 flex items-center gap-2">
                                <span class="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-amber-300">
                                    Stale
                                </span>
                                <button
                                    type="button"
                                    class="pointer-events-auto rounded-full border border-slate-600 bg-slate-900/90 px-3 py-1 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800"
                                    onClick={handleRetry}
                                >
                                    Retry
                                </button>
                            </div>
                        </Show>

                        <Show when={viewingGameNumber() !== null}>
                            <div class="pointer-events-none absolute left-4 top-4 rounded-full border border-slate-500/40 bg-slate-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-200">
                                Reviewing Game {viewingGameNumber()}
                            </div>
                        </Show>
                    </div>

                    <ScenarioLanes
                        scenarios={scenarios()}
                        isComputing={
                            viewingGameNumber() === null
                                ? isComputingFromContext()
                                : false
                        }
                    />
                </div>
            </div>
            <Show when={swapTarget()}>
                {(target) => (
                    <ChampionPicker
                        isOpen={true}
                        onClose={() => setSwapTarget(null)}
                        onSelect={(newChampionId) => {
                            const currentTarget = target();
                            swapChampion({
                                pathToParent: currentTarget.path.slice(0, -1),
                                newChampionId,
                                oldChampionId: currentTarget.oldChampionId
                            });
                            setSwapTarget(null);
                        }}
                        contextLabel={target().contextLabel}
                        actionVerb="Swap to"
                        disabledChampionIds={usedChampionIdSet()}
                        championColoring={(id) => swapColoringFor(id)}
                    />
                )}
            </Show>
            <Show when={branchTarget()}>
                {(target) => (
                    <ChampionPicker
                        isOpen={true}
                        onClose={() => setBranchTarget(null)}
                        onSelect={(newChampionId) => {
                            const t = target();
                            createBranch({
                                pathToParent: t.pathToParent,
                                newChampionId
                            });
                            setBranchTarget(null);
                        }}
                        contextLabel={target().contextLabel}
                        actionVerb="Add branch with"
                        disabledChampionIds={usedChampionIdSet()}
                        championColoring={(id) => branchColoringFor(id)}
                    />
                )}
            </Show>
        </>
    );
};

export default NavigatorDrafting;
