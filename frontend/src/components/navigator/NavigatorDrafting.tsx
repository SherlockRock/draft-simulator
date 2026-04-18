import { Component, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import DraftInputPanel from "./DraftInputPanel";
import DecisionTree from "./DecisionTree";
import ScenarioLanes from "./ScenarioLanes";

const NavigatorDrafting: Component = () => {
    const { joinSession, navigatorContext } = useNavigatorContext();
    const [selectedScenarioIdx, setSelectedScenarioIdx] = createSignal<number | null>(
        null
    );
    const [highlightedTreePath, setHighlightedTreePath] = createSignal<number[] | null>(
        null
    );

    const treeData = createMemo(() => navigatorContext().snapshot?.tree ?? null);
    const scenarios = createMemo(() => navigatorContext().snapshot?.scenarios ?? []);
    const lastConfirmedChampionId = createMemo(() => {
        const events = navigatorContext().events;
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.event_type === "ban" || event.event_type === "pick") {
                return event.champion_id;
            }
        }
        return null;
    });
    const isComputing = createMemo(
        () => navigatorContext().events.length > 0 && navigatorContext().snapshot === null
    );
    const isStale = createMemo(
        () => navigatorContext().snapshot === null && navigatorContext().events.length > 0
    );
    const activeSessionId = createMemo(() => navigatorContext().session?.id ?? null);

    createEffect(() => {
        const nextScenarios = scenarios();
        const selectedIndex = selectedScenarioIdx();

        if (nextScenarios.length === 0) {
            setSelectedScenarioIdx(null);
            setHighlightedTreePath(null);
        } else if (selectedIndex !== null && selectedIndex >= nextScenarios.length) {
            setSelectedScenarioIdx(null);
        }
    });

    const handleScenarioSelect = (index: number) => {
        const selected = scenarios()[index];
        setSelectedScenarioIdx(index);
        if (selected?.treePath) {
            setHighlightedTreePath(selected.treePath);
        }
    };

    const handleNodeClick = (nodePath: number[]) => {
        const matchIdx = scenarios().findIndex((scenario) =>
            nodePath.every((value, index) => scenario.treePath[index] === value)
        );

        setHighlightedTreePath(nodePath);
        setSelectedScenarioIdx(matchIdx >= 0 ? matchIdx : null);
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
                    isComputing={isComputing()}
                    highlightedPath={highlightedTreePath()}
                    rootChampionId={lastConfirmedChampionId()}
                    scenarioPaths={scenarios().map((scenario, index) => ({
                        path: scenario.treePath,
                        tier: selectedScenarioIdx() === index ? "selected" : "unselected"
                    }))}
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
                isComputing={isComputing()}
                selectedIndex={selectedScenarioIdx()}
                onSelectScenario={handleScenarioSelect}
            />
        </div>
    );
};

export default NavigatorDrafting;
