import { Component, createMemo, For, Show } from "solid-js";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeTotals,
    computeRoleDistribution,
    winrateColor
} from "../../utils/playerStats";
import {
    ROLES,
    ROLE_LABELS,
    roleIconUrl,
    getChampionImg
} from "../../utils/championRoles";

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
        <section class="flex w-[300px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
            <header class="border-b border-slate-700/60 p-3">
                <h2 class="truncate text-sm font-bold text-slate-100" title={riotId()}>
                    {props.result.input.gameName}
                    <span class="text-slate-500"> #{props.result.input.tagLine}</span>
                </h2>

                <Show when={props.result.status === "ok" && champRows().length > 0}>
                    <div class="mt-1.5 flex items-baseline gap-2">
                        <span class="text-[11px] text-slate-300">
                            {totals().wins}W {totals().losses}L
                        </span>
                        <span
                            class={`text-[11px] font-semibold ${winrateColor(totals().winrate)}`}
                        >
                            {totals().winrate}% WR
                        </span>
                        <span class="text-[10px] text-slate-500">
                            {totals().games} games
                        </span>
                    </div>
                    <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-400">
                        <For each={ROLES}>
                            {(role) => (
                                <Show when={roleDistribution()[role] > 0}>
                                    <span class="flex items-center gap-0.5">
                                        <img
                                            src={roleIconUrl(role)}
                                            alt={ROLE_LABELS[role]}
                                            title={ROLE_LABELS[role]}
                                            class="h-3.5 w-3.5 opacity-80"
                                        />
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
                    <p class="p-3 text-sm text-red-400">
                        {props.result.status === "error"
                            ? props.result.error
                            : "Couldn't scout this player."}
                    </p>
                }
            >
                <Show
                    when={champRows().length > 0}
                    fallback={
                        <p class="p-3 text-sm text-slate-400">
                            No ranked champion data found.
                        </p>
                    }
                >
                    <div class="custom-scrollbar flex max-h-[62vh] flex-col overflow-y-auto p-1.5">
                        <For each={champRows()}>
                            {(champ) => {
                                const wr = champ.games
                                    ? Math.round((champ.wins / champ.games) * 100)
                                    : 0;
                                const img = getChampionImg(champ.championId);
                                return (
                                    <div class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-700/30">
                                        <Show
                                            when={img}
                                            fallback={
                                                <div class="h-6 w-6 shrink-0 rounded bg-slate-700" />
                                            }
                                        >
                                            <img
                                                src={img}
                                                alt={champ.championId}
                                                class="h-6 w-6 shrink-0 rounded"
                                            />
                                        </Show>
                                        <span class="min-w-0 flex-1 truncate text-xs text-slate-100">
                                            {champ.championId}
                                        </span>
                                        <span class="text-[11px] text-slate-400">
                                            {champ.wins}W {champ.games - champ.wins}L
                                        </span>
                                        <span
                                            class={`w-8 text-right text-xs font-semibold ${winrateColor(wr)}`}
                                        >
                                            {wr}%
                                        </span>
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
