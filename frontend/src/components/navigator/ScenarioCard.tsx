import { Component, For, Show, createMemo } from "solid-js";
import {
    NavigatorRoleAssignment,
    NavigatorScenario,
    NavigatorWeightedAssignment
} from "../../contexts/NavigatorContext";
import { resolveChampion } from "../../utils/constants";
import { ChampionPortrait } from "../ChampionPortrait";

interface ScenarioCardProps {
    scenario: NavigatorScenario;
    isSelected: boolean;
    onClick: () => void;
}

type RoleKey = keyof NavigatorRoleAssignment;

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

const ROLE_ICON_BASE =
    "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg";

const ROLE_ICON_SLUG: Record<RoleKey, string> = {
    TOP: "position-top",
    JUNGLE: "position-jungle",
    MIDDLE: "position-middle",
    ADC: "position-bottom",
    SUPPORT: "position-utility"
};

const ROLE_LABEL: Record<RoleKey, string> = {
    TOP: "Top",
    JUNGLE: "Jungle",
    MIDDLE: "Mid",
    ADC: "ADC",
    SUPPORT: "Support"
};

const ROLE_KEYS: RoleKey[] = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"];

function buildRoleByChampion(
    assignments: NavigatorWeightedAssignment[]
): Map<string, RoleKey> {
    const result = new Map<string, RoleKey>();
    if (assignments.length === 0) return result;
    const top = assignments.reduce((best, candidate) =>
        candidate.weight > best.weight ? candidate : best
    );
    for (const role of ROLE_KEYS) {
        const championId = top.assignment[role];
        if (championId) result.set(championId, role);
    }
    return result;
}

// Standard League draft turn groupings
const BLUE_PICK_GROUPS: number[][] = [[0], [1, 2], [3, 4]];
const RED_PICK_GROUPS: number[][] = [[0, 1], [2], [3], [4]];
// Bans: 3 in ban1 + 2 in ban2 = 5 total per side
const BLUE_BAN_GROUPS: number[][] = [
    [0, 1, 2],
    [3, 4]
];
const RED_BAN_GROUPS: number[][] = [
    [0, 1, 2],
    [3, 4]
];

function padSlots(values: string[], size: number): Array<string | null> {
    return Array.from({ length: size }, (_, index) => values[index] ?? null);
}

const ChampionCircle: Component<{
    championId: string | null;
    borderClass: string;
    sizeClass?: string;
    banned?: boolean;
    role?: RoleKey;
}> = (props) => {
    const champion = createMemo(() =>
        props.championId ? resolveChampion(props.championId) : undefined
    );
    const sizeClass = () => props.sizeClass ?? "h-7 w-7";
    const showRoleBadge = () => !!props.role && !props.banned && !!champion();

    return (
        <div class={`relative ${sizeClass()}`}>
            <div
                class={`absolute inset-0 flex items-center justify-center overflow-hidden rounded-full border bg-slate-900 ${props.borderClass}`}
            >
                <Show
                    when={champion()}
                    fallback={<div class="h-full w-full rounded-full bg-slate-700/40" />}
                >
                    {(resolvedChampion) => (
                        <>
                            <ChampionPortrait
                                src={resolvedChampion().img}
                                alt={resolvedChampion().name}
                                class={
                                    props.banned
                                        ? "h-full w-full object-cover opacity-50 grayscale"
                                        : "h-full w-full object-cover"
                                }
                            />
                            <Show when={props.banned}>
                                <svg
                                    viewBox="0 0 24 24"
                                    class="pointer-events-none absolute inset-0 h-full w-full text-red-500"
                                    stroke="currentColor"
                                    stroke-width="2.5"
                                    fill="none"
                                >
                                    <line x1="4" y1="4" x2="20" y2="20" />
                                    <line x1="20" y1="4" x2="4" y2="20" />
                                </svg>
                            </Show>
                        </>
                    )}
                </Show>
            </div>
            <Show when={showRoleBadge()}>
                <div
                    class="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-900 ring-1 ring-slate-600/80"
                    title={ROLE_LABEL[props.role!]}
                >
                    <img
                        src={`${ROLE_ICON_BASE}/${ROLE_ICON_SLUG[props.role!]}.svg`}
                        alt={ROLE_LABEL[props.role!]}
                        class="h-2.5 w-2.5"
                    />
                </div>
            </Show>
        </div>
    );
};

const GroupedRow: Component<{
    values: string[];
    groups: number[][];
    totalSlots: number;
    bgClass: string;
    dividerClass: string;
    circleSize?: string;
    banned?: boolean;
    roleByChampion?: Map<string, RoleKey>;
}> = (props) => {
    const padded = createMemo(() => padSlots(props.values, props.totalSlots));

    return (
        <div class={`flex items-center rounded-md px-2 py-1 ${props.bgClass}`}>
            <For each={props.groups}>
                {(group, groupIndex) => (
                    <div class="flex items-center">
                        <Show when={groupIndex() > 0}>
                            <div class={`mx-2 h-5 w-px ${props.dividerClass}`} />
                        </Show>
                        <div class="flex gap-1">
                            <For each={group}>
                                {(slotIndex) => {
                                    const championId = padded()[slotIndex];
                                    const role =
                                        championId && props.roleByChampion
                                            ? props.roleByChampion.get(championId)
                                            : undefined;
                                    return (
                                        <ChampionCircle
                                            championId={championId}
                                            borderClass="border-slate-600/50"
                                            sizeClass={props.circleSize}
                                            banned={props.banned}
                                            role={role}
                                        />
                                    );
                                }}
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
    const blueRoleByChampion = createMemo(() =>
        buildRoleByChampion(props.scenario.blueLikelyAssignments)
    );
    const redRoleByChampion = createMemo(() =>
        buildRoleByChampion(props.scenario.redLikelyAssignments)
    );

    return (
        <button
            type="button"
            class={`flex w-[300px] flex-shrink-0 flex-col rounded-lg border p-3 text-left transition-colors ${
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

            <div class="mt-1.5 flex min-h-5 flex-wrap gap-1.5">
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

            <div class="mt-2 space-y-0.5">
                <GroupedRow
                    values={props.scenario.blueBans}
                    groups={BLUE_BAN_GROUPS}
                    totalSlots={5}
                    bgClass="bg-blue-500/5"
                    dividerClass="bg-blue-400/20"
                    banned
                />
                <GroupedRow
                    values={props.scenario.bluePicks}
                    groups={BLUE_PICK_GROUPS}
                    totalSlots={5}
                    bgClass="bg-blue-500/10"
                    dividerClass="bg-blue-400/25"
                    roleByChampion={blueRoleByChampion()}
                />
                <GroupedRow
                    values={props.scenario.redBans}
                    groups={RED_BAN_GROUPS}
                    totalSlots={5}
                    bgClass="bg-red-500/5"
                    dividerClass="bg-red-400/20"
                    banned
                />
                <GroupedRow
                    values={props.scenario.redPicks}
                    groups={RED_PICK_GROUPS}
                    totalSlots={5}
                    bgClass="bg-red-500/10"
                    dividerClass="bg-red-400/25"
                    roleByChampion={redRoleByChampion()}
                />
            </div>

            <p class="mt-2 line-clamp-2 text-xs text-slate-400">
                {props.scenario.description}
            </p>
        </button>
    );
};

export default ScenarioCard;
