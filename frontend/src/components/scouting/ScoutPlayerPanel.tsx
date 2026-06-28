import { Component, createMemo, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";
import type { ChampionStatsEnvelope, Role } from "@draft-sim/shared-types";
import { scoutPlayer } from "../../utils/scoutingApi";
import { ROLES, ROLE_LABELS } from "../../utils/championRoles";
import { StyledSelect } from "../StyledSelect";

const REGION_OPTIONS = [
    { value: "na1", label: "NA" },
    { value: "euw1", label: "EUW" },
    { value: "eun1", label: "EUNE" },
    { value: "kr", label: "KR" },
    { value: "br1", label: "BR" },
    { value: "oc1", label: "OCE" }
];

interface ChampRow {
    championId: string;
    games: number;
    wins: number;
}

const ScoutPlayerPanel: Component = () => {
    const [region, setRegion] = createSignal("na1");
    const [gameName, setGameName] = createSignal("");
    const [tagLine, setTagLine] = createSignal("");
    const [loading, setLoading] = createSignal(false);
    const [envelope, setEnvelope] = createSignal<ChampionStatsEnvelope | null>(null);

    const canScout = createMemo(
        () => gameName().trim().length > 0 && tagLine().trim().length > 0 && !loading()
    );

    // Aggregate per-(champ, role) envelope entries into per-champ totals,
    // sorted by games played (descending) — op.gg's champion-list ordering.
    const champRows = createMemo<ChampRow[]>(() => {
        const env = envelope();
        if (!env) return [];
        const map = new Map<string, ChampRow>();
        for (const e of env.entries) {
            const row = map.get(e.championId) ?? {
                championId: e.championId,
                games: 0,
                wins: 0
            };
            row.games += e.games;
            row.wins += e.wins;
            map.set(e.championId, row);
        }
        return [...map.values()].sort((a, b) => b.games - a.games);
    });

    const totals = createMemo(() => {
        const rows = champRows();
        const games = rows.reduce((s, r) => s + r.games, 0);
        const wins = rows.reduce((s, r) => s + r.wins, 0);
        return {
            games,
            wins,
            losses: games - wins,
            winrate: games ? Math.round((wins / games) * 100) : 0
        };
    });

    // Games played per role, for the role-distribution summary.
    const roleDistribution = createMemo(() => {
        const dist: Record<Role, number> = {
            top: 0,
            jungle: 0,
            mid: 0,
            adc: 0,
            support: 0
        };
        const env = envelope();
        if (!env) return dist;
        for (const e of env.entries) dist[e.role] += e.games;
        return dist;
    });

    const winrateColor = (wr: number) =>
        wr >= 60 ? "text-orange-400" : wr >= 50 ? "text-blue-300" : "text-slate-400";

    const handleScout = async () => {
        setLoading(true);
        try {
            const env = await scoutPlayer({
                region: region(),
                gameName: gameName().trim(),
                tagLine: tagLine().trim()
            });
            setEnvelope(env);
            if (env.entries.length === 0) {
                toast("No ranked champion data found for that profile.");
            }
        } catch {
            toast.error(
                "Couldn't scout that player — u.gg may be unavailable or the Riot ID is wrong."
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div class="custom-scrollbar h-full overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-6 p-6 sm:p-8">
                <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                    <h1 class="text-2xl font-bold text-slate-100">Scout a Player</h1>
                    <p class="mt-1 text-sm text-slate-400">
                        Enter a Riot ID to see their ranked champions, most-played first.
                    </p>
                    <div class="mt-5 grid gap-4 lg:grid-cols-[160px_1fr_140px_auto] lg:items-end">
                        <label class="block">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Region
                            </span>
                            <StyledSelect
                                value={region()}
                                onChange={setRegion}
                                options={REGION_OPTIONS}
                            />
                        </label>
                        <label class="block">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Game Name
                            </span>
                            <input
                                type="text"
                                value={gameName()}
                                onInput={(e) => setGameName(e.currentTarget.value)}
                                placeholder="e.g. Aeon"
                                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-400"
                            />
                        </label>
                        <label class="block">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Tag
                            </span>
                            <input
                                type="text"
                                value={tagLine()}
                                onInput={(e) => setTagLine(e.currentTarget.value)}
                                placeholder="NA3"
                                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-400"
                            />
                        </label>
                        <button
                            type="button"
                            onClick={handleScout}
                            disabled={!canScout()}
                            class="rounded-lg bg-blue-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                        >
                            {loading() ? "Scouting..." : "Scout"}
                        </button>
                    </div>
                </section>

                <Show when={envelope() && champRows().length > 0}>
                    <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                        <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700/60 pb-4">
                            <div class="flex items-baseline gap-3">
                                <span class="text-sm text-slate-300">
                                    {totals().wins}W {totals().losses}L
                                </span>
                                <span
                                    class={`text-sm font-semibold ${winrateColor(totals().winrate)}`}
                                >
                                    {totals().winrate}% WR
                                </span>
                                <span class="text-xs text-slate-500">
                                    {totals().games} games
                                </span>
                            </div>
                            <div class="flex flex-wrap gap-3 text-xs text-slate-400">
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
                        </div>

                        <div class="mt-3 flex flex-col">
                            <For each={champRows()}>
                                {(champ) => {
                                    const wr = champ.games
                                        ? Math.round((champ.wins / champ.games) * 100)
                                        : 0;
                                    return (
                                        <div class="flex items-center justify-between border-b border-slate-700/30 py-2 last:border-b-0">
                                            <span class="truncate text-sm text-slate-100">
                                                {champ.championId}
                                            </span>
                                            <div class="flex items-center gap-4 text-xs">
                                                <span class="text-slate-400">
                                                    {champ.wins}W{" "}
                                                    {champ.games - champ.wins}L
                                                </span>
                                                <span class="w-16 text-right text-slate-500">
                                                    {champ.games} games
                                                </span>
                                                <span
                                                    class={`w-10 text-right font-semibold ${winrateColor(wr)}`}
                                                >
                                                    {wr}%
                                                </span>
                                            </div>
                                        </div>
                                    );
                                }}
                            </For>
                        </div>
                    </section>
                </Show>
            </div>
        </div>
    );
};

export default ScoutPlayerPanel;
