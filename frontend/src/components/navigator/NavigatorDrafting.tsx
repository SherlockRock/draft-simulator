import { Component, Show, createEffect, createMemo, createSignal } from "solid-js";
import toast from "solid-toast";
import ChampionPicker, { type ChampionColorState } from "../ChampionPicker";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { getPickerState } from "../../utils/navigatorPool";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import { eventsToConfirmedTurns, pathStepsToIndexPath } from "../../utils/treeReconcile";
import DraftInputPanel from "./DraftInputPanel";
import DecisionTree from "./DecisionTree";
import ScenarioLanes from "./ScenarioLanes";
import { SeriesTabStrip } from "./SeriesTabStrip";
import { BetweenGamesPanel } from "./BetweenGamesPanel";
import EngineToggle from "./EngineToggle";

const NavigatorDrafting: Component = () => {
    const {
        joinSession,
        navigatorContext,
        syntheticTree,
        effectiveScenarios,
        isComputing: isComputingFromContext,
        isSessionActive,
        isStopping,
        onStop,
        onReroot,
        currentMeta,
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
    type ContentAddressedStep = { slot: number; championIds: string[] };
    const [swapTarget, setSwapTarget] = createSignal<{
        path: ContentAddressedStep[];
        targetSlot: number;
        oldChampionId: string;
        contextLabel: string;
        depth: number;
    } | null>(null);
    const [branchTarget, setBranchTarget] = createSignal<{
        path: ContentAddressedStep[];
        targetSlot: number;
        contextLabel: string;
        depth: number;
    } | null>(null);

    // Walks the synthetic tree using an index path and returns the
    // content-addressed lineage (slot + championIds at each step). Returns the
    // PARENT lineage (excludes the targeted node's own step), the targetSlot,
    // and the target's championIds for the picker label. Matches the protocol
    // EngineRequest.config.forcedBranches[].path shape.
    const deriveContentAddressedTarget = (
        indexPath: number[]
    ): {
        path: ContentAddressedStep[];
        targetSlot: number;
        championIds: string[];
    } | null => {
        const tree = syntheticTree();
        if (!tree || indexPath.length === 0) return null;
        const fullLineage: ContentAddressedStep[] = [];
        let node: NavigatorTreeNode | null = tree;
        for (const idx of indexPath) {
            if (!node || !node.children[idx]) return null;
            node = node.children[idx];
            fullLineage.push({
                slot: node.slots[0],
                championIds: [...node.championIds]
            });
        }
        if (!node) return null;
        const target = fullLineage[fullLineage.length - 1];
        return {
            path: fullLineage.slice(0, -1),
            targetSlot: target.slot,
            championIds: node.championIds
        };
    };

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
        // Phase 7b T14 (Decision 11): use the overlay so MCTS partial frames
        // surface their streaming scenarios without waiting for the final.
        return effectiveScenarios();
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
        const depth = swapTarget()?.depth ?? 0;
        const turnInfo = TURN_SEQUENCE[depth - 1];
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
        const depth = branchTarget()?.depth ?? 0;
        const turnInfo = TURN_SEQUENCE[depth - 1];
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
        const synth = syntheticTree();

        if (nextScenarios.length === 0) {
            setSelectedScenarioIndex(null);
            setHighlightedTreePath(null);
        } else if (selectedIndex !== null && selectedIndex >= nextScenarios.length) {
            setSelectedScenarioIndex(null);
        } else if (selectedIndex !== null && synth) {
            const selected = nextScenarios[selectedIndex];
            if (selected?.treePath) {
                const indexPath = pathStepsToIndexPath(synth, selected.treePath);
                if (indexPath) setHighlightedTreePath(indexPath);
            }
        }
    });

    const handleNodeClick = (nodePath: number[]) => {
        const synth = syntheticTree();
        const matchIdx = scenarios().findIndex((scenario) => {
            if (!synth) return false;
            const scenarioIndexPath = pathStepsToIndexPath(synth, scenario.treePath);
            if (!scenarioIndexPath) return false;
            if (nodePath.length > scenarioIndexPath.length) return false;
            return nodePath.every((value, index) => scenarioIndexPath[index] === value);
        });

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

    const handleOpenSwap = (indexPath: number[]) => {
        const target = deriveContentAddressedTarget(indexPath);
        if (!target) return;
        const oldChampionId = target.championIds[0];
        if (!oldChampionId) return;

        const turnInfo = TURN_SEQUENCE[indexPath.length - 1];
        const label = turnInfo
            ? `${turnInfo.side.toUpperCase()} ${turnInfo.type.toUpperCase()} ${indexPath.length}`
            : `TURN ${indexPath.length}`;

        setSwapTarget({
            path: target.path,
            targetSlot: target.targetSlot,
            oldChampionId,
            contextLabel: label,
            depth: indexPath.length
        });
    };

    const handleOpenBranch = (indexPath: number[]) => {
        const target = deriveContentAddressedTarget(indexPath);
        if (!target) return;
        const turnInfo = TURN_SEQUENCE[indexPath.length - 1];
        const label = turnInfo
            ? `${turnInfo.side.toUpperCase()} ${turnInfo.type.toUpperCase()} ${indexPath.length}`
            : `TURN ${indexPath.length}`;
        // For branch (mode: include) we add a sibling at the same slot as the
        // node the user clicked — so targetSlot is the clicked node's slot,
        // and path is the parent lineage (same as swap).
        setBranchTarget({
            path: target.path,
            targetSlot: target.targetSlot,
            contextLabel: label,
            depth: indexPath.length
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
                            isSessionActive={
                                viewingGameNumber() === null ? isSessionActive() : false
                            }
                            isStopping={isStopping()}
                            indicatorMeta={currentMeta()}
                            onStop={onStop}
                            highlightedPath={highlightedTreePath()}
                            confirmedDepth={confirmedDepth()}
                            scenarioPaths={(() => {
                                const synth = syntheticTree();
                                if (!synth) return [];
                                return scenarios().flatMap((scenario, index) => {
                                    const path = pathStepsToIndexPath(
                                        synth,
                                        scenario.treePath
                                    );
                                    if (!path) return [];
                                    return [
                                        {
                                            path,
                                            tier:
                                                selectedScenarioIndex() === index
                                                    ? ("selected" as const)
                                                    : ("unselected" as const)
                                        }
                                    ];
                                });
                            })()}
                            panRequest={panRequest()}
                            onNodeClick={handleNodeClick}
                            onPromoteToScenario={handlePromoteToScenario}
                            onConfirmProjectedPick={handleConfirmProjectedPick}
                            onOpenSwap={handleOpenSwap}
                            onOpenBranch={handleOpenBranch}
                            onReroot={onReroot}
                        />

                        <div class="pointer-events-none absolute right-4 top-4 flex items-center gap-2">
                            <Show when={isStale()}>
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
                            </Show>
                            <EngineToggle />
                        </div>

                        <Show
                            when={
                                navigatorContext().snapshot?.meta?.mctsMeta?.algorithm ===
                                "mcts"
                            }
                        >
                            <div class="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-purple-500/40 bg-purple-500/15 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-purple-200">
                                Experimental MCTS engine ·{" "}
                                {navigatorContext().snapshot?.meta?.mctsMeta
                                    ?.iterations ?? 0}{" "}
                                iters
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
                                path: currentTarget.path,
                                targetSlot: currentTarget.targetSlot,
                                newChampionId
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
                                path: t.path,
                                targetSlot: t.targetSlot,
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
