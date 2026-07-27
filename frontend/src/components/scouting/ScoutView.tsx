import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup
} from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import toast from "solid-toast";
import {
    MAX_SCOUT_PLAYERS,
    SCOUT_REGION_OPTIONS,
    type PlayerScoutResult,
    type Role,
    type Team
} from "@draft-sim/shared-types";
import { fetchTeams, updateTeamRoster } from "../../utils/actions";
import { useUser } from "../../userProvider";
import { createRosterWriteBack } from "./rosterWriteBackState";
import { createScoutFetch } from "./scoutFetchCoordinator";
import {
    serializeSubmitParam,
    parsePlayersInput,
    formatPlayersInput,
    parseTeamParam,
    serializeTeamParam,
    slottedPlayers,
    fullRoster,
    autoAssignRoles,
    computeSharedChamps,
    ROLE_ORDER,
    type PlayerId,
    type TeamParam,
    type AssignedPlayer
} from "../../utils/playerStats";
import { StyledSelect } from "../StyledSelect";
import { RoleColumn } from "./RoleColumn";
import { MatchupColumn } from "./MatchupColumn";
import { rowRefKey, type MatchupSide } from "./RoleSlot";
import { FlexStrip } from "./FlexStrip";
import { RosterStatusLabel } from "./RosterStatusLabel";

const getParamString = (param: string | string[] | undefined): string => {
    if (Array.isArray(param)) return param[0] || "";
    return param || "";
};

const slotResults = (
    param: TeamParam,
    lookup: (player: PlayerId) => PlayerScoutResult | null
): (PlayerScoutResult | null)[] =>
    param.kind === "slots"
        ? param.slots.map((slot) => (slot ? lookup(slot) : null))
        : [null, null, null, null, null];

// A throttle rejection is not an upstream outage. Saying "u.gg may be
// unavailable" when the user simply dragged four times inside ten seconds sends
// them away instead of making them wait a moment.
const THROTTLED_HINT =
    "Scouting too fast — only a few lookups are allowed every 10 seconds. Wait a moment and try again.";
const OUTAGE_HINT = "u.gg may be unavailable — try again.";

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

// Passing undefined DELETES a param. Shaped as a patch rather than a call so
// the drag gesture can merge it into the ONE setSearchParams it already makes.
const disarmPatch = (side: MatchupSide): { team?: undefined; enemyTeam?: undefined } =>
    side === "you" ? { team: undefined } : { enemyTeam: undefined };

const ScoutView: Component = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // URL is the source of truth for the active scout.
    const activeRegion = () => getParamString(searchParams.region) || "na1";
    const playersParam = () => getParamString(searchParams.players);
    const enemiesParam = () => getParamString(searchParams.enemies);
    const matchupMode = () => enemiesParam() !== "";
    const enemyRegion = () => getParamString(searchParams.enemyRegion) || activeRegion();

    const [user] = useUser()();
    const queryClient = useQueryClient();

    // Team UUIDs for roster write-back. Deliberately NOT named yourTeamParam /
    // enemyTeamParam — those already exist below and hold parsed player slots.
    const teamIdParam = () => getParamString(searchParams.team);
    const enemyTeamIdParam = () => getParamString(searchParams.enemyTeam);

    // fetchTeams returns ONLY owned teams, so resolving against this list IS
    // the ownership check. Anonymous visitors and shared links never arm.
    const teamsQuery = useQuery(() => ({
        queryKey: ["teams"],
        queryFn: fetchTeams,
        enabled: !!user() && (teamIdParam() !== "" || enemyTeamIdParam() !== "")
    }));
    const { armedTeam, savedTeams, writeBack, shouldKeepTeamParam } =
        createRosterWriteBack({
            isSignedIn: () => !!user(),
            ownedTeams: (): Team[] => teamsQuery.data ?? [],
            teamsResolved: () => teamsQuery.isSuccess,
            teamsFailed: () => teamsQuery.isError,
            teamIdFor: (side) => (side === "you" ? teamIdParam() : enemyTeamIdParam()),
            // Raw params, NOT activeRegion(): that defaults to "na1", so a link
            // with region stripped would silently convert a KR team to NA
            // (decision 28).
            regionFor: (side) =>
                side === "you"
                    ? getParamString(searchParams.region) || undefined
                    : getParamString(searchParams.enemyRegion) ||
                      getParamString(searchParams.region) ||
                      undefined,
            disarm: (side) => setSearchParams(disarmPatch(side)),
            saveRoster: async (teamId, payload) => {
                const fresh = await updateTeamRoster(
                    teamId,
                    payload.players,
                    payload.region
                );
                // Update the cache from the response rather than only
                // invalidating: invalidation is async, and a second gesture
                // before the refetch lands would otherwise merge against a
                // stale roster and delete a player the previous save just
                // added.
                queryClient.setQueryData<Team[]>(["teams"], (prev) =>
                    prev ? prev.map((t) => (t.id === fresh.id ? fresh : t)) : prev
                );
                void queryClient.invalidateQueries({ queryKey: ["teams"] });
            },
            // Stable id per (reason, team) so repeated drags replace the toast
            // instead of stacking one per drop.
            notifyError: (id, message) => toast.error(message, { id })
        });

    // Editable state, seeded from the URL so a shared link stays editable.
    const [region, setRegion] = createSignal(activeRegion());
    // Seeded from the FULL roster, not the slotted five: seeding from the five
    // would make pressing Scout re-serialize five and delete the bench.
    const [input, setInput] = createSignal(
        formatPlayersInput(fullRoster(parseTeamParam(playersParam())))
    );
    const [enemyInput, setEnemyInput] = createSignal(
        formatPlayersInput(fullRoster(parseTeamParam(enemiesParam())))
    );
    const [pulse, setPulse] = createSignal<{ keys: Set<string> } | null>(null);

    const yourTeamParam = createMemo(() => parseTeamParam(playersParam()));
    const enemyTeamParam = createMemo(() => parseTeamParam(enemiesParam()));
    // The scouted five. Bench players are deliberately never fetched, and this
    // is what keeps the request inside MAX_SCOUT_PLAYERS.
    const yourPlayers = createMemo(() => slottedPlayers(yourTeamParam()));
    const enemyPlayers = createMemo(() => slottedPlayers(enemyTeamParam()));

    const parsed = createMemo(() => parsePlayersInput(input()));
    const parsedPlayers = createMemo(() => parsed().players);
    const parsedEnemy = createMemo(() => parsePlayersInput(enemyInput()));
    const parsedEnemyPlayers = createMemo(() => parsedEnemy().players);
    const overCap = createMemo(() => parsedPlayers().length > MAX_SCOUT_PLAYERS);
    const enemyOverCap = createMemo(
        () => parsedEnemyPlayers().length > MAX_SCOUT_PLAYERS
    );

    // Columns read per-player cache entries; fetching stays batched. Created
    // unconditionally here, in the component body and OUTSIDE the render gate:
    // observers made inside `<Show when={hasScoutedFor(...)}>` would have no
    // observer for the data the gate itself reads, so the gate would never turn
    // reactive and the page would be permanently blank.
    const scout = createScoutFetch({
        queryClient,
        slottedFor: (side) => (side === "you" ? yourPlayers() : enemyPlayers()),
        regionFor: (side) => (side === "you" ? activeRegion() : enemyRegion()),
        isActive: (side) => side === "you" || matchupMode()
    });

    const canScout = createMemo(
        () => parsedPlayers().length > 0 || parsedEnemyPlayers().length > 0
    );
    const scouting = createMemo(
        () => scout.isFetching("you") || scout.isFetching("enemy")
    );
    const yourSlots = createMemo(() =>
        slotResults(yourTeamParam(), (p) => scout.resultFor("you", p))
    );
    const enemySlots = createMemo(() =>
        slotResults(enemyTeamParam(), (p) => scout.resultFor("enemy", p))
    );
    const throttled = createMemo(
        () =>
            scout.errorFor("you") === "throttled" ||
            scout.errorFor("enemy") === "throttled"
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
            players: serializeSubmitParam(yourTeamParam(), yourIds),
            enemies:
                enemyIds.length > 0
                    ? serializeSubmitParam(enemyTeamParam(), enemyIds)
                    : undefined,
            enemyRegion:
                enemyIds.length > 0 && enemy.region && enemy.region !== nextRegion
                    ? enemy.region
                    : undefined,
            // setSearchParams MERGES, so a stale team id would outlive the
            // roster it describes (decision 26a).
            // Omitting a key keeps it; passing undefined deletes it.
            ...(shouldKeepTeamParam("you", yourIds) ? {} : { team: undefined }),
            ...(shouldKeepTeamParam("enemy", enemyIds) ? {} : { enemyTeam: undefined })
        });
    };

    const assignFrom = (side: MatchupSide, players: PlayerId[]): (PlayerId | null)[] =>
        autoAssignRoles(scout.resultsFor(side, players)).map((slot) =>
            slot ? { gameName: slot.input.gameName, tagLine: slot.input.tagLine } : null
        );

    // A list-form side with zero players has nothing to assign — treat it as
    // already normalized so a bare /scout visit (or a matchup with one empty
    // side) never gets rewritten into an empty slot-form string like "s:,,,,".
    const isDone = (param: TeamParam): boolean =>
        param.kind === "slots" || param.players.length === 0;

    // Normalizes list-form params into slot-form so role assignment is URL
    // state. This runs on load and is NOT a user gesture — write-back must
    // NEVER hang off it (decision 26), or opening a link would mutate a roster.
    createEffect(() => {
        const you = yourTeamParam();
        const enemy = enemyTeamParam();
        const inMatchup = matchupMode();
        if (isDone(you) && (!inMatchup || isDone(enemy))) return;
        // Wait for the data auto-assign needs, but only for a side that has any.
        // The COMPLETE predicate, not the settled-or-failed one: normalizing on
        // partial data would freeze a half-guessed role assignment into the URL.
        if (
            you.kind === "list" &&
            you.players.length > 0 &&
            !scout.hasCompleteResultsFor("you")
        )
            return;
        if (
            inMatchup &&
            enemy.kind === "list" &&
            enemy.players.length > 0 &&
            !scout.hasCompleteResultsFor("enemy")
        )
            return;

        const nextPlayers =
            you.kind === "slots"
                ? serializeTeamParam(you.slots)
                : you.players.length === 0
                  ? playersParam()
                  : serializeTeamParam(assignFrom("you", you.players));
        const nextEnemies = inMatchup
            ? enemy.kind === "slots"
                ? serializeTeamParam(enemy.slots)
                : enemy.players.length === 0
                  ? enemiesParam()
                  : serializeTeamParam(assignFrom("enemy", enemy.players))
            : null;

        const changed =
            nextPlayers !== playersParam() ||
            (nextEnemies !== null && nextEnemies !== enemiesParam());
        if (!changed) return;

        setSearchParams(
            nextEnemies === null
                ? { players: nextPlayers }
                : { players: nextPlayers, enemies: nextEnemies },
            { replace: true }
        );
    });

    const rowRefs = new Map<string, HTMLDivElement>();
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(pulseTimer));

    // Accumulates keys so multi-target clicks (divider = both sides, flex = every
    // sharing teammate) pulse ALL their rows, not just the last call's.
    const scrollToRow = (side: MatchupSide, role: Role, championId: string) => {
        const key = rowRefKey(side, role, championId);
        rowRefs.get(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        setPulse((prev) => {
            const keys = new Set(prev?.keys ?? []);
            keys.add(key);
            return { keys };
        });
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => setPulse(null), 1500);
    };

    const swapRoles = (side: MatchupSide, from: Role, to: Role) => {
        const param = side === "you" ? yourTeamParam() : enemyTeamParam();
        if (param.kind !== "slots") return;
        const slots = [...param.slots];
        const fromIndex = ROLE_ORDER.indexOf(from);
        const toIndex = ROLE_ORDER.indexOf(to);
        const fromSlot = slots[fromIndex];
        slots[fromIndex] = slots[toIndex];
        slots[toIndex] = fromSlot;
        // Save BEFORE navigating, and fold any disarm into the same
        // setSearchParams: @solidjs/router navigates in a microtask-deferred
        // transition, so a second call this tick would merge against the
        // pre-swap search string and revert the drag. Pass the array we just
        // computed for the same reason — the URL has not settled.
        const outcome = writeBack(side, slots);
        setSearchParams({
            ...(side === "you"
                ? { players: serializeTeamParam(slots) }
                : { enemies: serializeTeamParam(slots) }),
            ...(outcome === "disarmed" ? disarmPatch(side) : {})
        });
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
                                options={SCOUT_REGION_OPTIONS}
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
                            <Show when={scout.errorFor("you")}>
                                {(kind) => (
                                    <p class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                                        {kind() === "throttled"
                                            ? THROTTLED_HINT
                                            : `Couldn't scout that squad — ${OUTAGE_HINT}`}
                                    </p>
                                )}
                            </Show>

                            <Show when={scout.hasScoutedFor("you")}>
                                <Show when={armedTeam("you")}>
                                    {(team) => (
                                        <RosterStatusLabel
                                            teamName={team().name}
                                            saved={savedTeams().has(team().id)}
                                        />
                                    )}
                                </Show>
                                <div class="custom-scrollbar flex gap-3 overflow-x-auto pb-2">
                                    <For each={ROLE_ORDER}>
                                        {(role, index) => (
                                            <RoleColumn
                                                role={role}
                                                result={yourSlots()[index()]}
                                                rowRefs={rowRefs}
                                                pulse={pulse()}
                                                onSwap={swapRoles}
                                            />
                                        )}
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
                        <Show when={armedTeam("you")}>
                            {(team) => (
                                <RosterStatusLabel
                                    teamName={team().name}
                                    saved={savedTeams().has(team().id)}
                                />
                            )}
                        </Show>
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
                                        onSwap={swapRoles}
                                    />
                                )}
                            </For>
                        </div>
                        <Show when={armedTeam("enemy")}>
                            {(team) => (
                                <RosterStatusLabel
                                    teamName={team().name}
                                    saved={savedTeams().has(team().id)}
                                />
                            )}
                        </Show>
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
                        <Show when={scout.isError("you") || scout.isError("enemy")}>
                            <p class="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                                {scout.isError("you") ? "Couldn't scout your team. " : ""}
                                {scout.isError("enemy")
                                    ? "Couldn't scout the enemy team. "
                                    : ""}
                                {throttled() ? THROTTLED_HINT : OUTAGE_HINT}
                            </p>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default ScoutView;
