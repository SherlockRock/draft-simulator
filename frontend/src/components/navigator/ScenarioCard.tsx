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

// Standard League draft pick turns per side
// Blue: [P1] | [P2, P3] | [P4, P5]
// Red: [R1, R2] | [R3] | [R4] | [R5]
const BLUE_PICK_GROUPS: number[][] = [[0], [1, 2], [3, 4]];
const RED_PICK_GROUPS: number[][] = [[0, 1], [2], [3], [4]];

function padPicks(picks: string[], size: number): Array<string | null> {
    return Array.from({ length: size }, (_, index) => picks[index] ?? null);
}

const ChampionCircle: Component<{
    championId: string | null;
    borderClass: string;
}> = (props) => {
    const champion = createMemo(() =>
        props.championId ? resolveChampion(props.championId) : undefined
    );

    return (
        <div
            class={`flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border bg-slate-900 ${props.borderClass}`}
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
};

const GroupedCompRow: Component<{
    picks: string[];
    groups: number[][];
    bgClass: string;
    dividerClass: string;
}> = (props) => {
    const paddedPicks = createMemo(() => padPicks(props.picks, 5));

    return (
        <div
            class={`flex items-center rounded-md px-2 py-1.5 ${props.bgClass}`}
        >
            <For each={props.groups}>
                {(group, groupIndex) => (
                    <div class="flex items-center">
                        <Show when={groupIndex() > 0}>
                            <div
                                class={`mx-2 h-6 w-px ${props.dividerClass}`}
                            />
                        </Show>
                        <div class="flex gap-1">
                            <For each={group}>
                                {(slotIndex) => (
                                    <ChampionCircle
                                        championId={paddedPicks()[slotIndex]}
                                        borderClass="border-slate-600/50"
                                    />
                                )}
                            </For>
                        </div>
                    </div>
                )}
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
            class={`flex w-[300px] flex-shrink-0 flex-col rounded-lg border p-4 text-left transition-colors ${
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

            <div class="mt-2 flex min-h-6 flex-wrap gap-1.5">
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

            <div class="mt-3 space-y-1.5">
                <GroupedCompRow
                    picks={props.scenario.bluePicks}
                    groups={BLUE_PICK_GROUPS}
                    bgClass="bg-blue-500/10"
                    dividerClass="bg-blue-400/25"
                />
                <GroupedCompRow
                    picks={props.scenario.redPicks}
                    groups={RED_PICK_GROUPS}
                    bgClass="bg-red-500/10"
                    dividerClass="bg-red-400/25"
                />
            </div>

            <p class="mt-3 line-clamp-2 text-xs text-slate-400">
                {props.scenario.description}
            </p>
        </button>
    );
};

export default ScenarioCard;
