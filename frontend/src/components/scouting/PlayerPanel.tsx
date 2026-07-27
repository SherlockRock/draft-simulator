import { Component, createMemo, createSignal, For, JSX, onCleanup, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import type { PlayerScoutResult, Role } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeTotals,
    computeRoleDistribution,
    computeMainRole,
    winrateColor
} from "../../utils/playerStats";
import { formatFetchedAgo } from "../../utils/scoutFreshness";
import {
    ROLES,
    ROLE_LABELS,
    ROLE_COLOR,
    roleIconUrl,
    getChampionImg
} from "../../utils/championRoles";

// WR ring geometry (r = 24 → circumference for stroke-dash math).
const RING_CIRC = 2 * Math.PI * 24;

// Static CSS-mask props shared by every tinted role glyph; the per-icon
// mask-image url and the bg-color tint class are applied at the call site.
const ROLE_MASK_STYLE: JSX.CSSProperties = {
    "-webkit-mask-repeat": "no-repeat",
    "mask-repeat": "no-repeat",
    "-webkit-mask-position": "center",
    "mask-position": "center",
    "-webkit-mask-size": "contain",
    "mask-size": "contain"
};

// A position glyph tinted via CSS mask (the source SVGs are white). `active`
// roles take their per-role accent color; inactive roles read as dim slate.
export const RoleIcon: Component<{ role: Role; active: boolean; class?: string }> = (
    props
) => (
    <span
        title={ROLE_LABELS[props.role]}
        class={`inline-block shrink-0 ${props.class ?? ""} ${
            props.active ? ROLE_COLOR[props.role].icon : "bg-slate-600"
        }`}
        style={{
            ...ROLE_MASK_STYLE,
            "-webkit-mask-image": `url(${roleIconUrl(props.role)})`,
            "mask-image": `url(${roleIconUrl(props.role)})`
        }}
    />
);

// The label counts minutes, so it has to re-read the clock on its own — nothing
// else on the page changes as a cached envelope ages.
const TICK_MS = 30_000;

const useNow = (): (() => number) => {
    const [now, setNow] = createSignal(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    onCleanup(() => clearInterval(timer));
    return now;
};

export const PlayerSummaryHeader: Component<{
    result: PlayerScoutResult;
    /** Omitted where a refresh has nowhere to go (previews, tests). */
    onRefresh?: () => void;
    /** A batch is already outstanding for this side — refreshing now would
     *  only burn the per-user request budget. */
    busy?: boolean;
}> = (props) => {
    const riotId = () => `${props.result.input.gameName} #${props.result.input.tagLine}`;

    const entries = () =>
        props.result.status === "ok" ? props.result.envelope.entries : [];

    const now = useNow();

    const champRows = createMemo(() => aggregateChampRows(entries()));
    const totals = createMemo(() => computeTotals(champRows()));
    const roleDistribution = createMemo(() => computeRoleDistribution(entries()));
    const mainRole = createMemo(() => computeMainRole(entries()));

    // From the envelope, so a response served out of the backend's TTL cache
    // reports when u.gg was actually asked.
    const fetchedAgo = () =>
        props.result.status === "ok"
            ? formatFetchedAgo(props.result.envelope.fetchedAt, now())
            : "";

    return (
        <header class="relative border-b border-slate-700/60 px-3 py-2.5">
            <Show when={props.onRefresh}>
                <button
                    type="button"
                    title={
                        props.busy
                            ? "Scouting…"
                            : `Refetch from u.gg${fetchedAgo() ? ` (fetched ${fetchedAgo()})` : ""}`
                    }
                    aria-label="Refetch this player from u.gg"
                    disabled={props.busy}
                    onClick={() => props.onRefresh?.()}
                    class="absolute right-1.5 top-1.5 rounded p-1 text-slate-600 transition-colors hover:bg-slate-700/40 hover:text-slate-200 focus-visible:text-slate-200 disabled:pointer-events-none disabled:opacity-40"
                >
                    <RefreshCw class="h-3 w-3" />
                </button>
            </Show>
            <Show
                when={props.result.status === "ok" && champRows().length > 0}
                fallback={
                    <h2 class="flex items-baseline gap-1 pr-5" title={riotId()}>
                        <span class="min-w-0 truncate text-sm font-bold text-slate-100">
                            {props.result.input.gameName}
                        </span>
                        <span class="shrink-0 text-sm text-slate-500">
                            #{props.result.input.tagLine}
                        </span>
                    </h2>
                }
            >
                <div class="flex items-center gap-3">
                    {/* Win/loss donut — green arc = win share, red = loss
                        share. The center % keeps the winrate heat color. */}
                    <div
                        class="relative shrink-0"
                        style={{ width: "58px", height: "58px" }}
                    >
                        <svg
                            width="58"
                            height="58"
                            viewBox="0 0 58 58"
                            class="-rotate-90"
                        >
                            {/* loss base (red), full ring */}
                            <circle
                                cx="29"
                                cy="29"
                                r="24"
                                fill="none"
                                stroke="#fb7185"
                                stroke-width="6"
                            />
                            {/* win arc (green) overlaid for the win share */}
                            <circle
                                cx="29"
                                cy="29"
                                r="24"
                                fill="none"
                                stroke="#4ade80"
                                stroke-width="6"
                                stroke-dasharray={`${
                                    totals().games
                                        ? RING_CIRC * (totals().wins / totals().games)
                                        : 0
                                } ${RING_CIRC}`}
                            />
                        </svg>
                        <div class="absolute inset-0 flex items-center justify-center">
                            <span
                                class={`text-sm font-bold tabular-nums ${winrateColor(totals().winrate)}`}
                            >
                                {totals().winrate}
                                <span class="text-[9px]">%</span>
                            </span>
                        </div>
                        <Show when={mainRole()}>
                            {(role) => (
                                <div
                                    class={`absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border-[1.5px] bg-slate-800 ${ROLE_COLOR[role()].border}`}
                                    style={{ width: "21px", height: "21px" }}
                                >
                                    <RoleIcon role={role()} active class="h-3 w-3" />
                                </div>
                            )}
                        </Show>
                    </div>

                    <div class="min-w-0 flex-1">
                        <h2 class="flex items-baseline gap-1 pr-5" title={riotId()}>
                            <span class="min-w-0 truncate text-sm font-bold text-slate-100">
                                {props.result.input.gameName}
                            </span>
                            <span class="shrink-0 text-xs text-slate-500">
                                #{props.result.input.tagLine}
                            </span>
                        </h2>
                        <div class="mt-0.5 text-xs tabular-nums">
                            <span class="font-semibold text-green-400">
                                {totals().wins}W
                            </span>{" "}
                            <span class="font-semibold text-rose-400">
                                {totals().losses}L
                            </span>
                        </div>
                        <div class="flex items-baseline gap-1 text-[10px] tabular-nums text-slate-500">
                            <span>{totals().games} games</span>
                            <Show when={fetchedAgo()}>
                                {(ago) => (
                                    <>
                                        <span class="text-slate-700">·</span>
                                        <span
                                            class="truncate"
                                            title="When u.gg was last asked"
                                        >
                                            {ago()}
                                        </span>
                                    </>
                                )}
                            </Show>
                        </div>
                    </div>
                </div>

                {/* All five roles, uniform size, per-role color, no emphasis. */}
                <div class="mt-2.5 flex items-center justify-between gap-1 border-t border-slate-700/40 pt-2.5">
                    <For each={ROLES}>
                        {(role) => {
                            const share = () => roleDistribution()[role];
                            const pct = () =>
                                totals().games
                                    ? Math.round((share() / totals().games) * 100)
                                    : 0;
                            return (
                                <span class="flex items-center gap-0.5">
                                    <RoleIcon
                                        role={role}
                                        active={share() > 0}
                                        class="h-3.5 w-3.5"
                                    />
                                    <span
                                        class={`text-[11px] tabular-nums ${
                                            share() > 0
                                                ? "text-slate-300"
                                                : "text-slate-600"
                                        }`}
                                    >
                                        {pct()}%
                                    </span>
                                </span>
                            );
                        }}
                    </For>
                </div>
            </Show>
        </header>
    );
};

export const ChampListSection: Component<{
    result: PlayerScoutResult;
    maxHeightClass?: string;
    highlightSet?: Set<string>;
    pulseChampionId?: string | null;
    onRowRef?: (championId: string, el: HTMLDivElement) => void;
}> = (props) => {
    const entries = () =>
        props.result.status === "ok" ? props.result.envelope.entries : [];

    const champRows = createMemo(() => aggregateChampRows(entries()));

    return (
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
                <div
                    class={`custom-scrollbar flex flex-col overflow-y-auto p-1.5 ${props.maxHeightClass ?? "max-h-[62vh]"}`}
                >
                    <For each={champRows()}>
                        {(champ) => {
                            const wr = champ.games
                                ? Math.round((champ.wins / champ.games) * 100)
                                : 0;
                            const img = getChampionImg(champ.championId);
                            return (
                                <div
                                    ref={(el) => props.onRowRef?.(champ.championId, el)}
                                    class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-700/30"
                                    classList={{
                                        "ring-1 ring-inset ring-amber-400/40":
                                            props.highlightSet?.has(champ.championId) ??
                                            false,
                                        "ring-2 ring-inset ring-amber-300 animate-pulse":
                                            props.pulseChampionId === champ.championId
                                    }}
                                >
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
    );
};
