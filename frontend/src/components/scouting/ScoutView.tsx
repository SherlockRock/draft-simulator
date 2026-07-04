import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { MAX_SCOUT_PLAYERS, type PlayerScoutResult, type Role } from "@draft-sim/shared-types";
import { scoutPlayers } from "../../utils/scoutingApi";
import {
    serializePlayersParam,
    parsePlayersInput,
    formatPlayersInput,
    parseTeamParam,
    serializeTeamParam,
    canonicalPlayersKey,
    autoAssignRoles,
    computeSharedChamps,
    ROLE_ORDER,
    type PlayerId,
    type TeamParam,
    type AssignedPlayer
} from "../../utils/playerStats";
import { StyledSelect } from "../StyledSelect";
import PlayerColumn from "./PlayerColumn";
import { MatchupColumn, rowRefKey, type MatchupSide } from "./MatchupColumn";
import { FlexStrip } from "./FlexStrip";

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

const teamPlayers = (param: TeamParam): PlayerId[] =>
    param.kind === "list" ? param.players : param.slots.filter((s): s is PlayerId => s !== null);

const playerKey = (p: { gameName: string; tagLine: string }): string =>
    `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`;

const resultsFor = (
    players: PlayerId[],
    results: PlayerScoutResult[]
): PlayerScoutResult[] =>
    players.flatMap((p) => {
        const result = results.find((r) => playerKey(r.input) === playerKey(p));
        return result ? [result] : [];
    });

const slotResults = (
    param: TeamParam,
    results: PlayerScoutResult[]
): (PlayerScoutResult | null)[] =>
    param.kind === "slots"
        ? param.slots.map((slot) =>
              slot ? (results.find((r) => playerKey(r.input) === playerKey(slot)) ?? null) : null
          )
        : [null, null, null, null, null];

const toAssigned = (slots: (PlayerScoutResult | null)[]): (AssignedPlayer | null)[] =>
    slots.map((slot, index) =>
        slot
            ? {
                  riotId: `${slot.input.gameName}#${slot.input.tagLine}`,
                  assignedRole: ROLE_ORDER[index],
                  entries: slot.status === "ok" ? slot.envelope.entries : []
              }
            : null
    );

const ScoutView: Component = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // URL is the source of truth for the active scout.
    const activeRegion = () => getParamString(searchParams.region) || "na1";
    const playersParam = () => getParamString(searchParams.players);
    const enemiesParam = () => getParamString(searchParams.enemies);
    const matchupMode = () => enemiesParam() !== "";
    const enemyRegion = () => getParamString(searchParams.enemyRegion) || activeRegion();

    // Editable state, seeded from the URL so a shared link stays editable.
    const [region, setRegion] = createSignal(activeRegion());
    const [input, setInput] = createSignal(
        formatPlayersInput(teamPlayers(parseTeamParam(playersParam())))
    );
    const [enemyInput, setEnemyInput] = createSignal(
        formatPlayersInput(teamPlayers(parseTeamParam(enemiesParam())))
    );
    const [pulse, setPulse] = createSignal<{ key: string } | null>(null);

    const yourTeamParam = createMemo(() => parseTeamParam(playersParam()));
    const enemyTeamParam = createMemo(() => parseTeamParam(enemiesParam()));
    const yourPlayers = createMemo(() => teamPlayers(yourTeamParam()));
    const enemyPlayers = createMemo(() => teamPlayers(enemyTeamParam()));

    const parsed = createMemo(() => parsePlayersInput(input()));
    const parsedPlayers = createMemo(() => parsed().players);
    const parsedEnemy = createMemo(() => parsePlayersInput(enemyInput()));
    const parsedEnemyPlayers = createMemo(() => parsedEnemy().players);
    const overCap = createMemo(() => parsedPlayers().length > MAX_SCOUT_PLAYERS);
    const enemyOverCap = createMemo(() => parsedEnemyPlayers().length > MAX_SCOUT_PLAYERS);

    const yourQuery = useQuery(() => ({
        queryKey: ["scoutPlayers", activeRegion(), canonicalPlayersKey(yourPlayers())],
        queryFn: () => scoutPlayers({ region: activeRegion(), players: yourPlayers() }),
        enabled: yourPlayers().length > 0,
        staleTime: 5 * 60 * 1000
    }));

    const enemyQuery = useQuery(() => ({
        queryKey: ["scoutPlayers", enemyRegion(), canonicalPlayersKey(enemyPlayers())],
        queryFn: () => scoutPlayers({ region: enemyRegion(), players: enemyPlayers() }),
        enabled: matchupMode() && enemyPlayers().length > 0,
        staleTime: 5 * 60 * 1000
    }));

    const canScout = createMemo(
        () => parsedPlayers().length > 0 || parsedEnemyPlayers().length > 0
    );
    const scouting = createMemo(() => yourQuery.isFetching || enemyQuery.isFetching);
    const single = createMemo(() => (yourQuery.data?.results.length ?? 0) === 1);
    const yourSlots = createMemo(() =>
        slotResults(yourTeamParam(), yourQuery.data?.results ?? [])
    );
    const enemySlots = createMemo(() =>
        slotResults(enemyTeamParam(), enemyQuery.data?.results ?? [])
    );

    const submit = () => {
        const you = parsed();
        const enemy = parsedEnemy();
        const yourIds = you.players.slice(0, MAX_SCOUT_PLAYERS);
        const enemyIds = enemy.players.slice(0, MAX_SCOUT_PLAYERS);
        if (yourIds.length === 0 && enemyIds.length === 0) return;
        const nextRegion = you.region ?? region();
        if (you.region) setRegion(you.region);
        setSearchParams({
            region: nextRegion,
            players: serializePlayersParam(yourIds),
            enemies: enemyIds.length > 0 ? serializePlayersParam(enemyIds) : undefined,
            enemyRegion:
                enemyIds.length > 0 && enemy.region && enemy.region !== nextRegion
                    ? enemy.region
                    : undefined
        });
    };

    createEffect(() => {
        if (!matchupMode()) return;
        const you = yourTeamParam();
        const enemy = enemyTeamParam();
        if (you.kind === "slots" && enemy.kind === "slots") return;
        if (you.kind === "list" && you.players.length > 0 && !yourQuery.data) return;
        if (enemy.kind === "list" && enemy.players.length > 0 && !enemyQuery.data) return;

        const nextYou =
            you.kind === "slots"
                ? you.slots
                : autoAssignRoles(resultsFor(you.players, yourQuery.data?.results ?? [])).map(
                      (slot) =>
                          slot
                              ? {
                                    gameName: slot.input.gameName,
                                    tagLine: slot.input.tagLine
                                }
                              : null
                  );
        const nextEnemy =
            enemy.kind === "slots"
                ? enemy.slots
                : autoAssignRoles(resultsFor(enemy.players, enemyQuery.data?.results ?? [])).map(
                      (slot) =>
                          slot
                              ? {
                                    gameName: slot.input.gameName,
                                    tagLine: slot.input.tagLine
                                }
                              : null
                  );

        setSearchParams(
            {
                players: serializeTeamParam(nextYou),
                enemies: serializeTeamParam(nextEnemy)
            },
            { replace: true }
        );
    });

    const rowRefs = new Map<string, HTMLDivElement>();
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(pulseTimer));

    const scrollToRow = (side: MatchupSide, role: Role, championId: string) => {
        const key = rowRefKey(side, role, championId);
        rowRefs.get(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        setPulse({ key });
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => setPulse(null), 1500);
    };

    const highlightFor = (col: number): { you: Set<string>; enemy: Set<string> } => {
        const you = yourSlots()[col];
        const enemy = enemySlots()[col];
        const shared = computeSharedChamps(
            you && you.status === "ok" ? you.envelope.entries : [],
            enemy && enemy.status === "ok" ? enemy.envelope.entries : []
        );
        const ids = new Set(shared.map((champ) => champ.championId));
        return { you: ids, enemy: ids };
    };

    return (
        <div class="custom-scrollbar h-full w-full overflow-y-auto bg-darius-bg bg-[radial-gradient(circle,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[length:24px_24px]">
            <div class="flex min-h-full w-full flex-col gap-6 p-6 sm:p-8">
                <section class="rounded-xl border border-slate-700/50 bg-slate-800/95 p-6">
                    <h1 class="text-2xl font-bold text-slate-100">Scout a Team</h1>
                    <p class="mt-1 text-sm text-slate-400">
                        Paste Riot IDs (<span class="text-slate-300">Name#TAG</span>,
                        comma-separated) or an op.gg multisearch URL.
                    </p>

                    <div class="mt-5 flex flex-col gap-3 lg:flex-row lg:items-end">
                        <label class="block lg:w-[150px]">
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
                                Your Team
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
                        <label class="block flex-1">
                            <span class="mb-2 block text-sm font-medium text-slate-300">
                                Enemy Team
                            </span>
                            <input
                                type="text"
                                value={enemyInput()}
                                onInput={(e) => setEnemyInput(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") submit();
                                }}
                                placeholder="enemy ids or op.gg link — leave empty for single-team scouting"
                                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none focus:border-blue-400"
                            />
                        </label>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={!canScout() || scouting()}
                            class="rounded-lg bg-blue-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/60"
                        >
                            {scouting() ? "Scouting..." : "Scout"}
                        </button>
                    </div>

                    <Show when={overCap()}>
                        <p class="mt-3 text-xs text-amber-400">
                            Up to {MAX_SCOUT_PLAYERS} players are scouted at once — only
                            the first {MAX_SCOUT_PLAYERS} will be shown.
                        </p>
                    </Show>
                    <Show when={enemyOverCap()}>
                        <p class="mt-3 text-xs text-amber-400">
                            Up to {MAX_SCOUT_PLAYERS} enemy players are scouted at once —
                            only the first {MAX_SCOUT_PLAYERS} will be shown.
                        </p>
                    </Show>
                </section>

                <Show
                    when={matchupMode()}
                    fallback={
                        <>
                            <Show when={yourQuery.isError}>
                                <p class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                                    Couldn't scout that squad — u.gg may be unavailable.
                                    Try again.
                                </p>
                            </Show>

                            <Show when={yourQuery.data}>
                                <div
                                    class="custom-scrollbar flex gap-3 overflow-x-auto pb-2"
                                    classList={{ "justify-center": single() }}
                                >
                                    <For each={yourQuery.data?.results}>
                                        {(result) => <PlayerColumn result={result} />}
                                    </For>
                                </div>
                            </Show>
                        </>
                    }
                >
                    <div class="flex flex-col gap-3">
                        <FlexStrip
                            label="Your team"
                            accentClass="text-blue-300"
                            team={toAssigned(yourSlots())}
                            onChipClick={(players, championId) =>
                                players.forEach((p) =>
                                    scrollToRow("you", p.assignedRole, championId)
                                )
                            }
                        />
                        <div class="custom-scrollbar flex gap-3 overflow-x-auto pb-2">
                            <For each={ROLE_ORDER}>
                                {(role, index) => (
                                    <MatchupColumn
                                        role={role}
                                        you={yourSlots()[index()]}
                                        enemy={enemySlots()[index()]}
                                        rowRefs={rowRefs}
                                        highlightYou={highlightFor(index()).you}
                                        highlightEnemy={highlightFor(index()).enemy}
                                        pulse={pulse()}
                                        onChipClick={scrollToRow}
                                    />
                                )}
                            </For>
                        </div>
                        <FlexStrip
                            label="Enemy team"
                            accentClass="text-rose-300"
                            team={toAssigned(enemySlots())}
                            onChipClick={(players, championId) =>
                                players.forEach((p) =>
                                    scrollToRow("enemy", p.assignedRole, championId)
                                )
                            }
                        />
                        <Show when={yourQuery.isError || enemyQuery.isError}>
                            <p class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                                {yourQuery.isError ? "Couldn't scout your team. " : ""}
                                {enemyQuery.isError ? "Couldn't scout the enemy team. " : ""}
                                u.gg may be unavailable — try again.
                            </p>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default ScoutView;
