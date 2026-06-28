import { Component, createMemo, createSignal, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { MAX_SCOUT_PLAYERS } from "@draft-sim/shared-types";
import { scoutPlayers } from "../../utils/scoutingApi";
import {
    parsePlayersParam,
    serializePlayersParam,
    type PlayerId
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

const emptyRow = (): PlayerId => ({ gameName: "", tagLine: "" });

const ScoutView: Component = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // URL is the source of truth for the active scout.
    const activeRegion = () => getParamString(searchParams.region) || "na1";
    const playersParam = () => getParamString(searchParams.players);
    const activePlayers = createMemo(() => parsePlayersParam(playersParam()));

    // Editable form state, seeded from the URL (so a shared link is editable).
    const seed = parsePlayersParam(getParamString(searchParams.players));
    const [region, setRegion] = createSignal(activeRegion());
    const [rows, setRows] = createSignal<PlayerId[]>(
        seed.length > 0 ? seed : [emptyRow()]
    );

    const completeRows = createMemo(() =>
        rows().filter((r) => r.gameName.trim() && r.tagLine.trim())
    );
    const canScout = createMemo(() => completeRows().length > 0);
    const canAddRow = createMemo(() => rows().length < MAX_SCOUT_PLAYERS);

    const updateRow = (i: number, patch: Partial<PlayerId>) => {
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    };
    const addRow = () => {
        if (canAddRow()) setRows((prev) => [...prev, emptyRow()]);
    };
    const removeRow = (i: number) => {
        setRows((prev) => {
            const next = prev.filter((_, idx) => idx !== i);
            return next.length > 0 ? next : [emptyRow()];
        });
    };

    const submit = () => {
        if (!canScout()) return;
        setSearchParams({
            region: region(),
            players: serializePlayersParam(completeRows())
        });
    };

    const query = useQuery(() => ({
        queryKey: ["scoutPlayers", activeRegion(), playersParam()],
        queryFn: () =>
            scoutPlayers({ region: activeRegion(), players: activePlayers() }),
        enabled: activePlayers().length > 0,
        staleTime: 5 * 60 * 1000
    }));

    const single = () => (query.data?.results.length ?? 0) === 1;

    return (
        <div class="custom-scrollbar h-full overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-6 p-6 sm:p-8">
                <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                    <h1 class="text-2xl font-bold text-slate-100">Scout a Team</h1>
                    <p class="mt-1 text-sm text-slate-400">
                        Enter up to {MAX_SCOUT_PLAYERS} Riot IDs to compare their ranked
                        champions side by side.
                    </p>

                    <div class="mt-5 flex flex-col gap-4">
                        <label class="block w-full sm:w-[200px]">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Region
                            </span>
                            <StyledSelect
                                value={region()}
                                onChange={setRegion}
                                options={REGION_OPTIONS}
                            />
                        </label>

                        <div class="flex flex-col gap-3">
                            <For each={rows()}>
                                {(row, i) => (
                                    <div class="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                                        <label class="block">
                                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                                Game Name
                                            </span>
                                            <input
                                                type="text"
                                                value={row.gameName}
                                                onInput={(e) =>
                                                    updateRow(i(), {
                                                        gameName: e.currentTarget.value
                                                    })
                                                }
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
                                                value={row.tagLine}
                                                onInput={(e) =>
                                                    updateRow(i(), {
                                                        tagLine: e.currentTarget.value
                                                    })
                                                }
                                                placeholder="NA3"
                                                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-400"
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => removeRow(i())}
                                            class="h-[46px] rounded-lg border border-slate-700 px-4 text-sm text-slate-400 transition-colors hover:border-red-500/60 hover:text-red-400"
                                            aria-label="Remove player"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}
                            </For>
                        </div>

                        <div class="flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                onClick={addRow}
                                disabled={!canAddRow()}
                                class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-blue-400 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                + Add player
                            </button>
                            <button
                                type="button"
                                onClick={submit}
                                disabled={!canScout() || query.isFetching}
                                class="rounded-lg bg-blue-500 px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                            >
                                {query.isFetching ? "Scouting..." : "Scout"}
                            </button>
                        </div>
                    </div>
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
