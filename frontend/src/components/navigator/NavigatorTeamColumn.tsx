import { Component, For, Index, Show, createMemo } from "solid-js";
import type { NavigatorEventData } from "../../contexts/NavigatorContext";
import { getChampionImg } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import { ROLE_SHORT_LABELS, roleGap } from "../../utils/navigatorRoles";
import {
    ROLE_HEX,
    bestPlayableSeat,
    infeasibleSummary,
    likelyRoles,
    seatMarginals,
    type Side
} from "../../utils/navigatorSeats";
import { TURN_SEQUENCE, turnLabel } from "../../utils/turnSequence";
import { SeatRing } from "./SeatRing";
import { SeatRow } from "./SeatRow";

export interface NavigatorTeamColumnProps {
    side: Side;
    /** Confirmed (ban/pick) events of BOTH sides in slot order; the column keeps its own. */
    events: NavigatorEventData[];
    ourSide: Side;
    /** The next slot to fill; null when the draft is complete or archived. */
    nextSlot: number | null;
    /** False in archive mode and between games: no glow, no tint, no button. */
    active: boolean;
    /** The glowing pick row's click — NavigatorDrafting focuses the pool search (design § 3, U2). */
    onPickNow: () => void;
}

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;
const slotsOf = (side: Side, type: "ban" | "pick"): number[] =>
    TURN_SEQUENCE.flatMap((t, i) => (t.side === side && t.type === type ? [i] : []));

/** Design § 3: one side's column — header, pick rows in DRAFT order (B1…B5 / R1…R5), the roles
 *  summary (the former gap strip, now a compact seat row), the bans in draft order. */
export const NavigatorTeamColumn: Component<NavigatorTeamColumnProps> = (props) => {
    const bySlot = createMemo(() => {
        const map = new Map<number, NavigatorEventData>();
        for (const e of props.events) map.set(e.slot, e);
        return map;
    });
    const pickSlots = createMemo(() => slotsOf(props.side, "pick"));
    const banSlots = createMemo(() => slotsOf(props.side, "ban"));
    const picks = createMemo(() =>
        pickSlots().flatMap((slot) => {
            const e = bySlot().get(slot);
            return e ? [e.champion_id] : [];
        })
    );
    const marginals = createMemo(() => seatMarginals(picks()));
    // Design § 2: on an infeasible side the solver's spread is ε-noise and is NOT rendered — the
    // rows show red rings at the best playable seat and "<Role> only" (the summary carries the reason).
    const infeasible = createMemo(() => picks().length > 0 && !roleGap(picks()).feasible);
    const nextTurn = () =>
        props.nextSlot === null ? null : (TURN_SEQUENCE[props.nextSlot] ?? null);
    const onClock = () => props.active && nextTurn()?.side === props.side;
    const glowSlots = createMemo<number[]>(() => {
        const slot = props.nextSlot;
        const turn = nextTurn();
        if (
            !props.active ||
            slot === null ||
            !turn ||
            turn.type !== "pick" ||
            turn.side !== props.side
        )
            return [];
        return turn.pairStart ? [slot, slot + 1] : [slot];
    });
    const label = (ordinal: number) => `${props.side === "blue" ? "B" : "R"}${ordinal}`;
    const sideText = () => (props.side === "blue" ? "text-blue-300" : "text-red-300");

    return (
        <div
            data-team-column={props.side}
            data-on-clock={onClock() ? "true" : "false"}
            class={`flex w-[230px] shrink-0 flex-col gap-2 overflow-y-auto px-3 py-3 ${props.side === "blue" ? "border-r" : "border-l"} border-darius-border/60 ${onClock() ? "bg-sky-300/[0.03]" : ""}`}
        >
            <div class={`text-sm font-bold ${sideText()}`}>
                {props.side === "blue" ? "Blue" : "Red"}
                <Show when={onClock()}>
                    <span class="ml-2 text-[10px] font-normal text-sky-300">
                        on the clock{props.side === props.ourSide ? " · you" : ""}
                    </span>
                </Show>
            </div>

            <Index each={pickSlots()}>
                {(slot, i) => {
                    const event = () => bySlot().get(slot());
                    const glow = () => glowSlots().includes(slot());
                    const first = () => glowSlots()[0] === slot();
                    const dist = () => {
                        const e = event();
                        return e ? (marginals().get(e.champion_id) ?? null) : null;
                    };
                    const note = createMemo(() => {
                        const d = dist();
                        return d ? likelyRoles(d) : [];
                    });
                    return (
                        <Show
                            when={event()}
                            fallback={
                                <Show
                                    when={glow()}
                                    fallback={
                                        <div
                                            data-pick-row={label(i + 1)}
                                            data-slot={slot()}
                                            data-filled="false"
                                            class="flex min-h-[50px] items-center gap-2 rounded-lg px-1.5 py-1 opacity-55"
                                        >
                                            <span class="w-[18px] text-[9px] font-bold text-slate-500">
                                                {label(i + 1)}
                                            </span>
                                            <span class="block h-[42px] w-[42px] rounded-full border-2 border-dashed border-slate-600" />
                                            <span class="text-[10px] text-slate-400">
                                                —
                                            </span>
                                        </div>
                                    }
                                >
                                    <button
                                        type="button"
                                        data-pick-row={label(i + 1)}
                                        data-slot={slot()}
                                        data-filled="false"
                                        data-glow="true"
                                        data-next-slot={first() ? "true" : undefined}
                                        aria-label={turnLabel(slot())}
                                        onClick={() => props.onPickNow()}
                                        class="flex min-h-[50px] w-full cursor-pointer items-center gap-2 rounded-lg border border-sky-300 px-1.5 py-1 text-left shadow-[0_0_0_2px_rgba(125,211,252,0.25)]"
                                    >
                                        <span class="w-[18px] text-[9px] font-bold text-slate-500">
                                            {label(i + 1)}
                                        </span>
                                        <span class="block h-[42px] w-[42px] shrink-0 rounded-full border-2 border-dashed border-sky-300" />
                                        <span class="min-w-0">
                                            <span class="block text-xs font-semibold text-sky-300">
                                                {label(i + 1)} — pick now
                                            </span>
                                            <span class="block text-[10px] text-slate-400">
                                                click, or just type a name
                                            </span>
                                        </span>
                                    </button>
                                </Show>
                            }
                        >
                            {(e) => (
                                <div
                                    data-pick-row={label(i + 1)}
                                    data-slot={slot()}
                                    data-filled="true"
                                    class="flex min-h-[50px] items-center gap-2 rounded-lg px-1.5 py-1"
                                >
                                    <span class="w-[18px] text-[9px] font-bold text-slate-500">
                                        {label(i + 1)}
                                    </span>
                                    <SeatRing
                                        championId={e().champion_id}
                                        dist={infeasible() ? null : dist()}
                                        marker={infeasible() ? "infeasible" : "none"}
                                        size={34}
                                        side={props.side}
                                    />
                                    <span class="min-w-0">
                                        <span class="block truncate text-xs font-semibold text-slate-50">
                                            {nameOf(e().champion_id)}
                                        </span>
                                        <span
                                            data-pick-note
                                            class="block text-[10px] text-slate-400"
                                        >
                                            <Show
                                                when={!infeasible()}
                                                fallback={`${ROLE_SHORT_LABELS[bestPlayableSeat(e().champion_id)]} only`}
                                            >
                                                <For each={note()}>
                                                    {(entry, k) => (
                                                        <>
                                                            {k() > 0 ? " · " : ""}
                                                            <b
                                                                style={{
                                                                    color: ROLE_HEX[
                                                                        entry.role
                                                                    ]
                                                                }}
                                                            >
                                                                {
                                                                    ROLE_SHORT_LABELS[
                                                                        entry.role
                                                                    ]
                                                                }
                                                            </b>{" "}
                                                            {entry.pct}%
                                                        </>
                                                    )}
                                                </For>
                                            </Show>
                                        </span>
                                    </span>
                                </div>
                            )}
                        </Show>
                    );
                }}
            </Index>

            <div
                data-roles-summary={props.side}
                class="mt-1 flex items-center gap-2 border-t border-darius-border/60 pt-2"
            >
                <span class="w-[30px] text-[9px] uppercase tracking-wider text-slate-500">
                    roles
                </span>
                <SeatRow
                    ids={picks()}
                    side={props.side}
                    size="compact"
                    infeasibleText={infeasibleSummary(picks(), nameOf)}
                />
            </div>

            <div class="flex items-center gap-2 border-t border-darius-border/60 pt-2">
                <span class="w-[30px] text-[9px] uppercase tracking-wider text-slate-500">
                    bans
                </span>
                <span class="flex gap-1">
                    <Index each={banSlots()}>
                        {(slot, i) => {
                            const e = () => bySlot().get(slot());
                            const title = () => {
                                const ev = e();
                                return ev
                                    ? `${turnLabel(slot())}: ${nameOf(ev.champion_id)}`
                                    : turnLabel(slot());
                            };
                            return (
                                <span
                                    data-ban-slot={slot()}
                                    data-filled={e() ? "true" : "false"}
                                    title={title()}
                                    class={`relative block h-[22px] w-[22px] rounded-full ${e() ? "" : "border border-dashed border-slate-600"}`}
                                >
                                    <Show when={e()}>
                                        {(ev) => (
                                            <>
                                                <img
                                                    src={getChampionImg(ev().champion_id)}
                                                    alt={nameOf(ev().champion_id)}
                                                    draggable={false}
                                                    class="h-full w-full rounded-full object-cover opacity-55 grayscale"
                                                />
                                                <span class="absolute left-1 right-1 top-1/2 h-px -rotate-45 bg-red-400" />
                                            </>
                                        )}
                                    </Show>
                                    <span class="sr-only">{`${i + 1}`}</span>
                                </span>
                            );
                        }}
                    </Index>
                </span>
            </div>
        </div>
    );
};
