import { Component, Show } from "solid-js";
import { getChampionImg } from "../../utils/championRoles";
import { resolveChampion } from "../../utils/constants";
import {
    MARKER_HEX,
    ringGradient,
    ringTitle,
    type RoleDist,
    type SeatMarker,
    type Side
} from "../../utils/navigatorSeats";

export interface SeatRingProps {
    championId: string;
    /** The champion's team-aware marginals; null = the side-coloured base ring. */
    dist: RoleDist | null;
    /** Portrait diameter in px; the ring adds `ring` px around it. */
    size: number;
    /** Ring thickness in px (default 4 — design § 2). */
    ring?: number;
    marker?: SeatMarker;
    side: Side;
    /** A ban: greyed portrait with a slash. */
    slash?: boolean;
    /** Tooltip override; default = ringTitle(name, dist), or the name without a dist. */
    title?: string;
}

const SIDE_HEX: Record<Side, string> = { blue: "#60a5fa", red: "#f87171" };
const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;

/** Design § 2 SeatRing: a portrait inside a conic ring of the five role colours (fixed order
 *  Top, Jg, Mid, ADC, Sup, each arc = the marginal). Markers are a 2px outer glow: sky candidate,
 *  amber moved, red infeasible (an infeasible ring is solid red — the spread is ε-noise there).
 *  No numbers on screen; the tooltip lists the roles ≥ 5%. */
export const SeatRing: Component<SeatRingProps> = (props) => {
    const ring = () => props.ring ?? 4;
    const marker = () => props.marker ?? "none";
    const outer = () => props.size + ring() * 2;
    const background = () => {
        if (marker() === "infeasible") return MARKER_HEX.infeasible;
        const gradient = props.dist ? ringGradient(props.dist) : "";
        return gradient === "" ? SIDE_HEX[props.side] : gradient;
    };
    const glow = () => {
        const m = marker();
        return m === "none" ? "none" : `0 0 0 2px ${MARKER_HEX[m]}`;
    };
    const title = () =>
        props.title ??
        (props.dist
            ? ringTitle(nameOf(props.championId), props.dist)
            : nameOf(props.championId));
    return (
        <span
            data-seat-ring
            data-champion={props.championId}
            data-marker={marker()}
            data-slash={props.slash === true ? "true" : "false"}
            title={title()}
            class="relative inline-flex shrink-0 items-center justify-center rounded-full"
            style={{
                width: `${outer()}px`,
                height: `${outer()}px`,
                background: background(),
                "box-shadow": glow()
            }}
        >
            <img
                src={getChampionImg(props.championId)}
                alt={nameOf(props.championId)}
                draggable={false}
                class={`rounded-full border border-darius-bg object-cover ${props.slash === true ? "opacity-50 grayscale" : ""}`}
                style={{ width: `${props.size}px`, height: `${props.size}px` }}
            />
            <Show when={props.slash === true}>
                <span class="absolute left-1/4 right-1/4 top-1/2 h-0.5 -rotate-45 bg-red-400" />
            </Show>
        </span>
    );
};
