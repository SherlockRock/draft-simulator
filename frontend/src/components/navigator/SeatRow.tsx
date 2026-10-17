import { Component, Index, Show, createMemo } from "solid-js";
import type { Role } from "@draft-sim/shared-types";
import { ROLE_COLOR, ROLE_LABELS, roleIconUrl } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import { seatPlan, type Seat, type Side } from "../../utils/navigatorSeats";
import { SeatRing } from "./SeatRing";

export interface SeatRowProps {
    ids: readonly string[];
    /** Drawn with the sky glow (both halves of a pair node). */
    candidateIds?: readonly string[];
    /** Baseline for the amber "moved" marker; default = ids minus candidateIds. */
    beforeIds?: readonly string[];
    side: Side;
    /** compact = 26px rings (roles summary, hover preview); card = 30px (candidate cards). */
    size: "compact" | "card";
    /** Ban cards / ban-turn previews: the candidate's ring carries the slash. */
    slashCandidate?: boolean;
    /** Shown beside the row when the side is infeasible (infeasibleSummary). */
    infeasibleText?: string | null;
}

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;

/** CommunityDragon position glyph, CSS-masked and tinted in the role's colour (U6) — the same
 *  recipe as scouting/PlayerPanel.tsx. `class` sets the box (default 10px). */
export const RoleGlyph: Component<{ role: Role; class?: string }> = (props) => (
    <span
        aria-label={ROLE_LABELS[props.role]}
        class={`block ${ROLE_COLOR[props.role].icon} ${props.class ?? "h-2.5 w-2.5"}`}
        style={{
            "-webkit-mask-image": `url(${roleIconUrl(props.role)})`,
            "mask-image": `url(${roleIconUrl(props.role)})`,
            "-webkit-mask-size": "contain",
            "mask-size": "contain",
            "-webkit-mask-repeat": "no-repeat",
            "mask-repeat": "no-repeat",
            "-webkit-mask-position": "center",
            "mask-position": "center"
        }}
    />
);

function seatTitle(seat: Seat): string {
    const label = ROLE_LABELS[seat.role];
    if (seat.occupant === null) return `${label}: open`;
    const pct = seat.dist ? ` ${Math.round(seat.dist[seat.role] * 100)}%` : "";
    const more = seat.count >= 2 ? ` + ${seat.count - 1} more` : "";
    return `${label}: ${nameOf(seat.occupant)}${pct}${more}`;
}

/** Design § 2 SeatRow: five seats in role order, each the role glyph over the champion
 *  topSeating puts there (or a dashed hole); the rule table is seatPlan's. `Index`, not `For`:
 *  the five positions are stable and the plan is re-allocated on every prop change. */
export const SeatRow: Component<SeatRowProps> = (props) => {
    const plan = createMemo(() =>
        seatPlan({
            ids: props.ids,
            candidateIds: props.candidateIds,
            beforeIds: props.beforeIds,
            denyMode: props.slashCandidate === true
        })
    );
    const portrait = () => (props.size === "card" ? 22 : 18);
    const hole = () => portrait() + 8;
    const candidates = () => new Set(props.candidateIds ?? []);
    return (
        <span
            data-seat-row
            data-infeasible={plan().infeasible ? "true" : "false"}
            class="inline-flex items-center gap-1.5"
        >
            <Index each={plan().seats}>
                {(seat) => (
                    <span
                        data-seat={seat().role}
                        data-occupant={seat().occupant ?? undefined}
                        data-open={seat().occupant === null ? "true" : undefined}
                        data-marker={seat().marker}
                        data-count={seat().count >= 2 ? seat().count : undefined}
                        title={seatTitle(seat())}
                        class="relative flex flex-col items-center gap-0.5"
                    >
                        <RoleGlyph role={seat().role} />
                        <Show
                            when={seat().occupant}
                            fallback={
                                <span
                                    class="block rounded-full border-2 border-dashed border-slate-600 opacity-70"
                                    style={{
                                        width: `${hole()}px`,
                                        height: `${hole()}px`
                                    }}
                                />
                            }
                        >
                            {(id) => (
                                <SeatRing
                                    championId={id()}
                                    dist={seat().dist}
                                    size={portrait()}
                                    marker={seat().marker}
                                    side={props.side}
                                    slash={
                                        props.slashCandidate === true &&
                                        candidates().has(id())
                                    }
                                />
                            )}
                        </Show>
                        <Show when={seat().count >= 2}>
                            <span class="absolute -right-1 top-2 rounded-full bg-red-500 px-1 text-[9px] font-bold text-slate-50">
                                {seat().count}
                            </span>
                        </Show>
                    </span>
                )}
            </Index>
            <Show when={plan().infeasible && props.infeasibleText}>
                {(text) => (
                    <span data-infeasible-text class="ml-1 text-[11px] text-red-300">
                        {text()}
                    </span>
                )}
            </Show>
        </span>
    );
};
