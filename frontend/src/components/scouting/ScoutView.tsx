import { Component, createMemo, createSignal, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { MAX_SCOUT_PLAYERS } from "@draft-sim/shared-types";
import { scoutPlayers } from "../../utils/scoutingApi";
import {
    parsePlayersParam,
    serializePlayersParam,
    parsePlayersInput,
    formatPlayersInput
} from "../../utils/playerStats";
import { StyledSelect } from "../StyledSelect";
import PlayerColumn from "./PlayerColumn";

const REGION_OPTIONS = [
    { value: "na1", label: "NA" },
    { value: "euw1", label: "EUW" },
    { value: "eun1", label: "EUNE" },
    { value: "kr", label: "KR" },
    { value: "br1", label: "BR" },
    { value: "oc1", label: "OCE" }
];

const getParamString = (param: string | string[] | undefined): string => {
    if (Array.isArray(param)) return param[0] || "";
    return param || "";
};

const ScoutView: Component = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // URL is the source of truth for the active scout.
    const activeRegion = () => getParamString(searchParams.region) || "na1";
    const playersParam = () => getParamString(searchParams.players);
    const activePlayers = createMemo(() => parsePlayersParam(playersParam()));

    // Editable state, seeded from the URL so a shared link stays editable.
    const [region, setRegion] = createSignal(activeRegion());
    const [input, setInput] = createSignal(formatPlayersInput(activePlayers()));

    const parsed = createMemo(() => parsePlayersInput(input()));
    const parsedPlayers = createMemo(() => parsed().players);
    const overCap = createMemo(() => parsedPlayers().length > MAX_SCOUT_PLAYERS);
    const canScout = createMemo(() => parsedPlayers().length > 0);

    const submit = () => {
        const p = parsed();
        const players = p.players.slice(0, MAX_SCOUT_PLAYERS);
        if (players.length === 0) return;
        const nextRegion = p.region ?? region();
        if (p.region) setRegion(p.region);
        setSearchParams({
            region: nextRegion,
            players: serializePlayersParam(players)
        });
    };

    const query = useQuery(() => ({
        queryKey: ["scoutPlayers", activeRegion(), playersParam()],
        queryFn: () => scoutPlayers({ region: activeRegion(), players: activePlayers() }),
        enabled: activePlayers().length > 0,
        staleTime: 5 * 60 * 1000
    }));

    const single = () => (query.data?.results.length ?? 0) === 1;

    return (
        <div class="custom-scrollbar h-full w-full overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="flex min-h-full w-full flex-col gap-6 p-6 sm:p-8">
                <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                    <h1 class="text-2xl font-bold text-slate-100">Scout a Team</h1>
                    <p class="mt-1 text-sm text-slate-400">
                        Paste Riot IDs (<span class="text-slate-300">Name#TAG</span>,
                        comma-separated) or an op.gg multisearch URL.
                    </p>

                    <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                        <label class="block sm:w-[150px]">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Region
                            </span>
                            <StyledSelect
                                value={region()}
                                onChange={setRegion}
                                options={REGION_OPTIONS}
                            />
                        </label>
                        <label class="block flex-1">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Players
                            </span>
                            <input
                                type="text"
                                value={input()}
                                onInput={(e) => setInput(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") submit();
                                }}
                                placeholder="city mouse#yum,khuromee#emate,White#KWAN  —  or paste an op.gg multisearch link"
                                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-400"
                            />
                        </label>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={!canScout() || query.isFetching}
                            class="rounded-lg bg-blue-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                        >
                            {query.isFetching ? "Scouting..." : "Scout"}
                        </button>
                    </div>

                    <Show when={overCap()}>
                        <p class="mt-3 text-xs text-amber-400">
                            Up to {MAX_SCOUT_PLAYERS} players are scouted at once — only
                            the first {MAX_SCOUT_PLAYERS} will be shown.
                        </p>
                    </Show>
                </section>

                <Show when={query.isError}>
                    <p class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                        Couldn't scout that squad — u.gg may be unavailable. Try again.
                    </p>
                </Show>

                <Show when={query.data}>
                    <div
                        class="custom-scrollbar flex gap-4 overflow-x-auto pb-2"
                        classList={{ "justify-center": single() }}
                    >
                        <For each={query.data?.results}>
                            {(result) => <PlayerColumn result={result} />}
                        </For>
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default ScoutView;
