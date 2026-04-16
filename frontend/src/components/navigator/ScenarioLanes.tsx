import { Component, For, Show, createMemo } from "solid-js";
import { NavigatorScenario } from "../../contexts/NavigatorContext";
import ScenarioCard from "./ScenarioCard";

interface ScenarioLanesProps {
    scenarios: NavigatorScenario[];
    isComputing: boolean;
    selectedIndex: number | null;
    onSelectScenario: (index: number) => void;
}

const ScenarioLanes: Component<ScenarioLanesProps> = (props) => {
    const hasScenarios = createMemo(() => props.scenarios.length > 0);
    const showSkeletons = createMemo(
        () => props.isComputing && props.scenarios.length === 0
    );

    return (
        <div class="h-full border-t border-slate-700/50 bg-slate-900/50">
            <div class="flex h-full flex-col">
                <div class="flex items-center justify-between px-4 pt-3">
                    <div class="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Scenario Lanes
                    </div>
                    <Show when={hasScenarios()}>
                        <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">
                            {props.scenarios.length} scenarios
                        </div>
                    </Show>
                </div>

                <div class="custom-scrollbar flex flex-1 gap-4 overflow-x-auto p-4">
                    <Show when={showSkeletons()}>
                        <For each={[0, 1, 2]}>
                            {() => (
                                <div class="h-full w-[280px] flex-shrink-0 animate-pulse rounded-lg border border-slate-700/50 bg-slate-800/50 p-4">
                                    <div class="mb-2 h-4 w-32 rounded bg-slate-700/50" />
                                    <div class="mb-3 h-3 w-48 rounded bg-slate-700/30" />
                                    <div class="mb-2 flex gap-1">
                                        <For each={[0, 1, 2, 3, 4]}>
                                            {() => (
                                                <div class="h-6 w-6 rounded-full bg-slate-700/50" />
                                            )}
                                        </For>
                                    </div>
                                    <div class="flex gap-1">
                                        <For each={[0, 1, 2, 3, 4]}>
                                            {() => (
                                                <div class="h-6 w-6 rounded-full bg-slate-700/30" />
                                            )}
                                        </For>
                                    </div>
                                </div>
                            )}
                        </For>
                    </Show>

                    <Show when={hasScenarios()}>
                        <For each={props.scenarios}>
                            {(scenario, index) => (
                                <ScenarioCard
                                    scenario={scenario}
                                    isSelected={props.selectedIndex === index()}
                                    onClick={() => props.onSelectScenario(index())}
                                />
                            )}
                        </For>
                    </Show>

                    <Show when={!hasScenarios() && !showSkeletons()}>
                        <div class="flex h-full min-w-full items-center justify-center rounded-lg border border-dashed border-slate-700/50 bg-slate-800/40 text-sm text-slate-500">
                            Waiting for scenario output
                        </div>
                    </Show>
                </div>
            </div>
        </div>
    );
};

export default ScenarioLanes;
