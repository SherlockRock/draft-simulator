import { Component, For, Show } from "solid-js";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeTotals,
    computeMainRole,
    winrateColor
} from "../../utils/playerStats";
import { ROLE_LABELS, roleIconUrl } from "../../utils/championRoles";

interface SquadSummaryBarProps {
    results: PlayerScoutResult[];
}

// Compact, scannable team-level strip: one cell per player with their overall
// winrate, W-L, games, and main-role icon — for a fast read across the squad.
// Detail lives in the columns below.
const SquadSummaryBar: Component<SquadSummaryBarProps> = (props) => {
    return (
        <div class="custom-scrollbar flex gap-3 overflow-x-auto rounded-xl border border-slate-700/50 bg-slate-800/95 p-3">
            <For each={props.results}>
                {(result) => {
                    const entries = result.status === "ok" ? result.envelope.entries : [];
                    const totals = computeTotals(aggregateChampRows(entries));
                    const mainRole = computeMainRole(entries);
                    const hasData = result.status === "ok" && totals.games > 0;
                    return (
                        <div class="flex w-[160px] shrink-0 flex-col gap-1 rounded-lg bg-slate-900/60 p-3">
                            <div
                                class="truncate text-xs font-semibold text-slate-100"
                                title={`${result.input.gameName} #${result.input.tagLine}`}
                            >
                                {result.input.gameName}
                            </div>
                            <Show
                                when={hasData}
                                fallback={
                                    <span class="text-[11px] text-slate-500">
                                        {result.status === "error"
                                            ? "scout failed"
                                            : "no ranked data"}
                                    </span>
                                }
                            >
                                <div class="flex items-baseline gap-2">
                                    <span
                                        class={`text-lg font-bold ${winrateColor(totals.winrate)}`}
                                    >
                                        {totals.winrate}%
                                    </span>
                                    <Show when={mainRole}>
                                        {(role) => (
                                            <img
                                                src={roleIconUrl(role())}
                                                alt={ROLE_LABELS[role()]}
                                                title={ROLE_LABELS[role()]}
                                                class="h-4 w-4 opacity-80"
                                            />
                                        )}
                                    </Show>
                                </div>
                                <div class="text-[11px] text-slate-400">
                                    {totals.wins}W {totals.losses}L
                                    <span class="text-slate-600"> · </span>
                                    {totals.games} games
                                </div>
                            </Show>
                        </div>
                    );
                }}
            </For>
        </div>
    );
};

export default SquadSummaryBar;
