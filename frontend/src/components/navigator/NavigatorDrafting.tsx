import { Component, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import { eventsToConfirmedTurns } from "../../utils/treeReconcile";
import DraftInputPanel from "./DraftInputPanel";
import DecisionTree from "./DecisionTree";
import ScenarioLanes from "./ScenarioLanes";

const NavigatorDrafting: Component = () => {
    const {
        joinSession,
        navigatorContext,
        syntheticTree,
        isComputing: isComputingFromContext,
        selectedScenarioIndex,
        setSelectedScenarioIndex,
        panRequest
    } = useNavigatorContext();
    const [highlightedTreePath, setHighlightedTreePath] = createSignal<number[] | null>(
        null
    );

    const treeData = syntheticTree;
    const scenarios = createMemo(() => navigatorContext().snapshot?.scenarios ?? []);
    const confirmedDepth = createMemo(
        () => eventsToConfirmedTurns(navigatorContext().events).length + 1
    );
    const isStale = createMemo(
        () =>
            navigatorContext().snapshot === null &&
            navigatorContext().events.length > 0 &&
            !isComputingFromContext()
    );
    const activeSessionId = createMemo(() => navigatorContext().session?.id ?? null);

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

    return (
        <div
            class="grid h-full w-full"
            style={{
                "grid-template-columns": "300px 1fr",
                "grid-template-rows": "1fr 280px"
            }}
        >
            <div class="row-span-2 overflow-y-auto border-r border-slate-700/50">
                <DraftInputPanel />
            </div>

            <div class="relative min-h-0 bg-slate-900/20">
                <DecisionTree
                    treeData={treeData()}
                    isComputing={isComputingFromContext()}
                    highlightedPath={highlightedTreePath()}
                    confirmedDepth={confirmedDepth()}
                    scenarioPaths={scenarios().map((scenario, index) => ({
                        path: scenario.treePath,
                        tier: selectedScenarioIndex() === index ? "selected" : "unselected"
                    }))}
                    panRequest={panRequest()}
                    onNodeClick={handleNodeClick}
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
            </div>

            <ScenarioLanes
                scenarios={scenarios()}
                isComputing={isComputingFromContext()}
            />
        </div>
    );
};

export default NavigatorDrafting;
