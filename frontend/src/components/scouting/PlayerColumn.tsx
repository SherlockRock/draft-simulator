import { Component, createMemo, For, Show } from "solid-js";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeTotals,
    computeRoleDistribution,
    winrateColor
} from "../../utils/playerStats";
import { ROLES, ROLE_LABELS } from "../../utils/championRoles";

interface PlayerColumnProps {
    result: PlayerScoutResult;
}

const PlayerColumn: Component<PlayerColumnProps> = (props) => {
    const riotId = () => `${props.result.input.gameName} #${props.result.input.tagLine}`;

    const entries = () =>
        props.result.status === "ok" ? props.result.envelope.entries : [];

    const champRows = createMemo(() => aggregateChampRows(entries()));
    const totals = createMemo(() => computeTotals(champRows()));
    const roleDistribution = createMemo(() => computeRoleDistribution(entries()));

    return (
        <section class="flex w-[340px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
            <header class="border-b border-slate-700/60 p-4">
                <h2 class="truncate text-base font-bold text-slate-100" title={riotId()}>
                    {props.result.input.gameName}
                    <span class="text-slate-500"> #{props.result.input.tagLine}</span>
                </h2>

                <Show when={props.result.status === "ok" && champRows().length > 0}>
                    <div class="mt-2 flex items-baseline gap-2">
                        <span class="text-xs text-slate-300">
                            {totals().wins}W {totals().losses}L
                        </span>
                        <span
                            class={`text-xs font-semibold ${winrateColor(totals().winrate)}`}
                        >
                            {totals().winrate}% WR
                        </span>
                        <span class="text-[11px] text-slate-500">
                            {totals().games} games
                        </span>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                        <For each={ROLES}>
                            {(role) => (
                                <Show when={roleDistribution()[role] > 0}>
                                    <span>
                                        {ROLE_LABELS[role]}{" "}
                                        <span class="text-slate-300">
                                            {Math.round(
                                                (roleDistribution()[role] /
                                                    totals().games) *
                                                    100
                                            )}
                                            %
                                        </span>
                                    </span>
                                </Show>
                            )}
                        </For>
                    </div>
                </Show>
            </header>

            <Show
                when={props.result.status === "ok"}
                fallback={
                    <p class="p-4 text-sm text-red-400">
                        {props.result.status === "error"
                            ? props.result.error
                            : "Couldn't scout this player."}
                    </p>
                }
            >
                <Show
                    when={champRows().length > 0}
                    fallback={
                        <p class="p-4 text-sm text-slate-400">
                            No ranked champion data found.
                        </p>
                    }
                >
                    <div class="custom-scrollbar flex max-h-[60vh] flex-col overflow-y-auto p-2">
                        <For each={champRows()}>
                            {(champ) => {
                                const wr = champ.games
                                    ? Math.round((champ.wins / champ.games) * 100)
                                    : 0;
                                return (
                                    <div class="flex items-center justify-between border-b border-slate-700/30 px-2 py-2 last:border-b-0">
                                        <span class="truncate text-sm text-slate-100">
                                            {champ.championId}
                                        </span>
                                        <div class="flex items-center gap-3 text-xs">
                                            <span class="text-slate-400">
                                                {champ.wins}W {champ.games - champ.wins}L
                                            </span>
                                            <span
                                                class={`w-9 text-right font-semibold ${winrateColor(wr)}`}
                                            >
                                                {wr}%
                                            </span>
                                        </div>
                                    </div>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </Show>
        </section>
    );
};

export default PlayerColumn;
