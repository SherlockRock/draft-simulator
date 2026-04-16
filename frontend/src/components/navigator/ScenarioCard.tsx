import { Component, For, Show, createMemo } from "solid-js";
import { NavigatorScenario } from "../../contexts/NavigatorContext";
import { resolveChampion } from "../../utils/constants";

interface ScenarioCardProps {
    scenario: NavigatorScenario;
    isSelected: boolean;
    onClick: () => void;
}

const perspectiveBadgeClasses: Record<NavigatorScenario["perspective"], string> = {
    robust: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    likely: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    off_profile: "bg-amber-500/20 text-amber-400 border-amber-500/30"
};

const perspectiveLabels: Record<NavigatorScenario["perspective"], string> = {
    robust: "Robust",
    likely: "Likely",
    off_profile: "Off profile"
};

function padTeamComp(picks: string[]): Array<string | null> {
    return Array.from({ length: 5 }, (_, index) => picks[index] ?? null);
}

const TeamCompRow: Component<{
    picks: string[];
    borderClass: string;
    opacityClass?: string;
}> = (props) => {
    const paddedPicks = createMemo(() => padTeamComp(props.picks));

    return (
        <div class={`flex gap-1 ${props.opacityClass ?? ""}`}>
            <For each={paddedPicks()}>
                {(championId) => {
                    const champion = createMemo(() =>
                        championId ? resolveChampion(championId) : undefined
                    );

                    return (
                        <div
                            class={`flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border bg-slate-900 ${props.borderClass}`}
                        >
                            <Show
                                when={champion()}
                                fallback={
                                    <div class="h-full w-full rounded-full bg-slate-700/40" />
                                }
                            >
                                {(resolvedChampion) => (
                                    <img
                                        src={resolvedChampion().img}
                                        alt={resolvedChampion().name}
                                        class="h-full w-full object-cover"
                                    />
                                )}
                            </Show>
                        </div>
                    );
                }}
            </For>
        </div>
    );
};

const ScenarioCard: Component<ScenarioCardProps> = (props) => {
    const visibleIndicators = createMemo(() => props.scenario.indicators.slice(0, 3));
    const remainingIndicatorCount = createMemo(() =>
        Math.max(props.scenario.indicators.length - 3, 0)
    );

    return (
        <button
            type="button"
            class={`flex h-[190px] w-[280px] flex-shrink-0 flex-col rounded-lg border p-4 text-left transition-colors ${
                props.isSelected
                    ? "border-blue-400 bg-slate-800/90 shadow-lg shadow-blue-500/10"
                    : "border-slate-700/50 bg-slate-800"
            }`}
            onClick={() => props.onClick()}
        >
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
                    {props.scenario.name}
                </div>
                <div
                    class={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${perspectiveBadgeClasses[props.scenario.perspective]}`}
                >
                    {perspectiveLabels[props.scenario.perspective]}
                </div>
            </div>

            <div class="mt-3 flex min-h-6 flex-wrap gap-2">
                <For each={visibleIndicators()}>
                    {(indicator) => (
                        <span class="rounded-full bg-slate-700/50 px-2 py-0.5 text-xs text-slate-300">
                            {indicator}
                        </span>
                    )}
                </For>
                <Show when={remainingIndicatorCount() > 0}>
                    <span class="rounded-full bg-slate-700/50 px-2 py-0.5 text-xs text-slate-300">
                        +{remainingIndicatorCount()} more
                    </span>
                </Show>
            </div>

            <div class="mt-4 space-y-2">
                <TeamCompRow
                    picks={props.scenario.bluePicks}
                    borderClass="border-blue-500/50"
                />
                <TeamCompRow
                    picks={props.scenario.redPicks}
                    borderClass="border-red-500/50"
                    opacityClass="opacity-70"
                />
            </div>

            <p class="mt-auto line-clamp-2 text-xs text-slate-400">
                {props.scenario.description}
            </p>
        </button>
    );
};

export default ScenarioCard;
