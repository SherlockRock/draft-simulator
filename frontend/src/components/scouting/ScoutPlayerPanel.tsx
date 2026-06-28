import { Component, createMemo, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";
import type { ChampionStatsEnvelope } from "@draft-sim/shared-types";
import { scoutPlayer } from "../../utils/scoutingApi";
import type { Role } from "@draft-sim/shared-types";
import {
    scorePool,
    DEFAULT_COMFORT_WEIGHTS,
    type ComfortWeights,
    type ScoredChamp
} from "../../utils/comfort";
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

const ScoutPlayerPanel: Component = () => {
    const [region, setRegion] = createSignal("na1");
    const [gameName, setGameName] = createSignal("");
    const [tagLine, setTagLine] = createSignal("");
    const [loading, setLoading] = createSignal(false);
    const [envelope, setEnvelope] = createSignal<ChampionStatsEnvelope | null>(null);
    const [weights, setWeights] = createSignal<ComfortWeights>({
        ...DEFAULT_COMFORT_WEIGHTS
    });

    const canScout = createMemo(
        () => gameName().trim().length > 0 && tagLine().trim().length > 0 && !loading()
    );

    // Re-scores live as sliders move (pure recompute — Task 2).
    const scored = createMemo<ScoredChamp[]>(() => {
        const env = envelope();
        if (!env) return [];
        return scorePool(env.entries, weights(), new Date());
    });

    // Real type guard (no `as`): asserts a string is one of the five engine roles.
    const isRole = (value: string): value is Role => ROLES.some((r) => r === value);

    const byRole = createMemo<Record<Role, ScoredChamp[]>>(() => {
        const groups: Record<Role, ScoredChamp[]> = {
            top: [],
            jungle: [],
            mid: [],
            adc: [],
            support: []
        };
        for (const champ of scored()) {
            if (isRole(champ.role)) groups[champ.role].push(champ);
        }
        return groups;
    });

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
            // Surface failure over silent stale data (design §9).
            toast.error(
                "Couldn't scout that player — u.gg may be unavailable or the Riot ID is wrong."
            );
        } finally {
            setLoading(false);
        }
    };

    const setWeight = (key: keyof ComfortWeights, value: number) =>
        setWeights((prev) => ({ ...prev, [key]: value }));

    return (
        <div class="custom-scrollbar h-full overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-6 p-6 sm:p-8">
                <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                    <h1 class="text-2xl font-bold text-slate-100">Scout a Player</h1>
                    <p class="mt-1 text-sm text-slate-400">
                        Enter a Riot ID to derive a comfort-ranked champion pool from
                        ranked match data.
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
                                placeholder="e.g. Faker"
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
                                placeholder="NA1"
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

                <Show when={envelope()}>
                    <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                        <h2 class="text-lg font-semibold text-slate-100">
                            Comfort Weights
                        </h2>
                        <div class="mt-4 grid gap-5 sm:grid-cols-3">
                            <For each={["games", "winRate", "recency"] as const}>
                                {(key) => (
                                    <label class="block">
                                        <span class="mb-2 flex justify-between text-sm font-medium text-slate-300">
                                            <span>
                                                {key === "winRate"
                                                    ? "Win Rate"
                                                    : key[0].toUpperCase() + key.slice(1)}
                                            </span>
                                            <span class="text-slate-400">
                                                {weights()[key]}
                                            </span>
                                        </span>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={weights()[key]}
                                            onInput={(e) =>
                                                setWeight(
                                                    key,
                                                    Number(e.currentTarget.value)
                                                )
                                            }
                                            class="w-full accent-blue-500"
                                        />
                                    </label>
                                )}
                            </For>
                        </div>
                    </section>

                    <section class="grid gap-4 lg:grid-cols-5">
                        <For each={ROLES}>
                            {(role) => (
                                <div class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-3">
                                    <h3 class="mb-3 text-sm font-semibold text-slate-200">
                                        {ROLE_LABELS[role]}
                                    </h3>
                                    <Show
                                        when={byRole()[role].length > 0}
                                        fallback={
                                            <p class="text-xs text-slate-500">
                                                No champions.
                                            </p>
                                        }
                                    >
                                        <div class="flex flex-col gap-2">
                                            <For each={byRole()[role]}>
                                                {(champ) => (
                                                    <div class="flex items-center justify-between rounded-lg bg-slate-900 px-3 py-2">
                                                        <div class="min-w-0">
                                                            <p class="truncate text-sm text-slate-100">
                                                                {champ.championId}
                                                            </p>
                                                            <p class="text-xs text-slate-500">
                                                                {champ.wins}/{champ.games}{" "}
                                                                (
                                                                {Math.round(
                                                                    (champ.wins /
                                                                        champ.games) *
                                                                        100
                                                                )}
                                                                %)
                                                            </p>
                                                        </div>
                                                        <span class="ml-2 shrink-0 rounded bg-blue-500/20 px-2 py-1 text-xs font-semibold text-blue-300">
                                                            {Math.round(
                                                                champ.comfort * 100
                                                            )}
                                                        </span>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </div>
                            )}
                        </For>
                    </section>
                </Show>
            </div>
        </div>
    );
};

export default ScoutPlayerPanel;
