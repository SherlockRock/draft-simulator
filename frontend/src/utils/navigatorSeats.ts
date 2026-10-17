import type { Role } from "@draft-sim/shared-types";
import {
    ROLES,
    getChampionPlayable,
    getChampionRoles,
    getChampionShares
} from "./championRoles";
import {
    ROLE_SHORT_LABELS,
    roleGap,
    roleOf,
    solveRoles,
    topAssignment
} from "./navigatorRoles";

// Navigator UX push design § 2 ("Data" + the rule table). Everything the seat rings show is
// derived here from the untouched role module: the solver's weighted assignments become
// per-champion marginals (one champion's five numbers sum to 1), the top assignment becomes the
// seating, and the prune's feasibility (roleGap, playable set) decides whether the spread is shown
// at all — for an infeasible side it is ε-noise and every champion sits at its best playable seat.

export type Side = "blue" | "red";
export const otherSide = (side: Side): Side => (side === "blue" ? "red" : "blue");

export type SeatMarker = "none" | "candidate" | "moved" | "infeasible";
export type RoleDist = Record<Role, number>;
export type Seating = Record<Role, string | null>;

/** Tailwind's *-400 values — the five colours ROLE_COLOR (RoleFilter, pool editor) already uses. */
export const ROLE_HEX: Record<Role, string> = {
    top: "#f87171",
    jungle: "#34d399",
    mid: "#60a5fa",
    adc: "#fbbf24",
    support: "#c084fc"
};
export const MARKER_HEX: Record<Exclude<SeatMarker, "none">, string> = {
    candidate: "#7dd3fc",
    moved: "#fbbf24",
    infeasible: "#ef4444"
};
/** A seat change counts as a move only when it was this certain before AND is after (design § 2). */
export const DECISIVE_MARGINAL = 0.5;
/** Arcs below this are not drawn (design § 2 "ring"). */
export const RING_MIN_ARC = 0.005;
/** The pick-row note lists roles at or above this (design § 3). */
export const NOTE_MIN = 0.1;
/** The ring's tooltip lists roles at or above this (design § 2 SeatRing). */
export const TITLE_MIN = 0.05;

const zeroDist = (): RoleDist => ({ top: 0, jungle: 0, mid: 0, adc: 0, support: 0 });
const uniq = (ids: readonly string[]): string[] => [...new Set(ids)];
const byMarginalThenRoleOrder =
    (dist: RoleDist) =>
    (a: Role, b: Role): number =>
        dist[b] - dist[a] || ROLES.indexOf(a) - ROLES.indexOf(b);

/** For every (champion, role): the summed weight of the assignments seating the champion there. */
export function seatMarginals(ids: readonly string[]): Map<string, RoleDist> {
    const list = uniq(ids);
    const out = new Map<string, RoleDist>(list.map((id) => [id, zeroDist()]));
    for (const w of solveRoles(list)) {
        for (const id of list) {
            const role = roleOf(w.assignment, id);
            const dist = out.get(id);
            if (role && dist) dist[role] += w.weight;
        }
    }
    return out;
}

/** The highest-weight assignment as seat → champion (first in enumeration order on ties);
 *  null for 0 or > 5 champions (solveRoles is empty there). */
export function topSeating(ids: readonly string[]): Seating | null {
    const list = uniq(ids);
    const top = topAssignment(list);
    if (!top) return null;
    const seating: Seating = {
        top: null,
        jungle: null,
        mid: null,
        adc: null,
        support: null
    };
    for (const id of list) {
        const role = roleOf(top.assignment, id);
        if (role) seating[role] = id;
    }
    return seating;
}

function seatOf(seating: Seating, id: string): Role | null {
    for (const role of ROLES) if (seating[role] === id) return role;
    return null;
}

export interface SeatMove {
    championId: string;
    from: Role;
    to: Role;
}

/** The threshold rule on its own (pure, testable with synthetic marginals): a champion of `ids`
 *  whose seat differs between `prev` and `next` AND whose marginal at the old seat was ≥ 0.50
 *  before and at the new seat is ≥ 0.50 after. A 0.47 → 0.23 shuffle between near-tied seats
 *  (Diana + Ekko + Nidalee) is not a move. */
export function decisiveMoves(
    ids: readonly string[],
    prev: Seating,
    next: Seating,
    marginalsBefore: ReadonlyMap<string, RoleDist>,
    marginalsAfter: ReadonlyMap<string, RoleDist>
): SeatMove[] {
    const out: SeatMove[] = [];
    for (const id of uniq(ids)) {
        const from = seatOf(prev, id);
        const to = seatOf(next, id);
        if (!from || !to || from === to) continue;
        const oldMarginal = marginalsBefore.get(id)?.[from] ?? 0;
        const newMarginal = marginalsAfter.get(id)?.[to] ?? 0;
        if (oldMarginal >= DECISIVE_MARGINAL && newMarginal >= DECISIVE_MARGINAL)
            out.push({ championId: id, from, to });
    }
    return out;
}

/** Teammates of `before` whose seat moved decisively once `after` is seated. */
export function seatMoves(
    before: readonly string[],
    after: readonly string[]
): SeatMove[] {
    const prev = topSeating(before);
    const next = topSeating(after);
    if (!prev || !next) return [];
    return decisiveMoves(before, prev, next, seatMarginals(before), seatMarginals(after));
}

/** The playable role with the largest share (first in playable order on ties); the listed roles
 *  when the table has no playable set; `top` for an unknown champion. */
export function bestPlayableSeat(championId: string): Role {
    const playable = getChampionPlayable(championId);
    const candidates = playable.length > 0 ? playable : getChampionRoles(championId);
    if (candidates.length === 0) return "top";
    const shares = getChampionShares(championId);
    if (!shares) return candidates[0];
    let best = candidates[0];
    for (const role of candidates) if (shares[role] > shares[best]) best = role;
    return best;
}

export interface Seat {
    role: Role;
    /** The champion topSeating puts here (infeasible: the first champion whose best playable seat this is). */
    occupant: string | null;
    /** 0 open, 1 seated, ≥ 2 a collision (infeasible only). */
    count: number;
    marker: SeatMarker;
    /** The occupant's team-aware marginals; null for a hole and on an infeasible side. */
    dist: RoleDist | null;
}
export interface SeatPlanInput {
    ids: readonly string[];
    /** Champions drawn with the sky glow (both halves of a pair node). */
    candidateIds?: readonly string[];
    /** The baseline for `seatMoves`; default = ids minus candidateIds. */
    beforeIds?: readonly string[];
    /** A ban row (plan-level decision 15): feasibility is judged on `beforeIds` alone and the
     *  candidate is overlaid at its best playable seat (count 2 on a collision) instead of
     *  flipping the opponent's whole row red. */
    denyMode?: boolean;
}
export interface SeatPlan {
    seats: Seat[];
    infeasible: boolean;
    /** The deduplicated ids the plan was computed for. */
    ids: string[];
}

const openSeat = (role: Role): Seat => ({
    role,
    occupant: null,
    count: 0,
    marker: "none",
    dist: null
});

/** Design § 2 rule table: seating / ring / open seat / candidate / moved / infeasible / empty side. */
export function seatPlan(input: SeatPlanInput): SeatPlan {
    const ids = uniq(input.ids);
    const candidates = new Set(input.candidateIds ?? []);
    const beforeIds = input.beforeIds ?? ids.filter((id) => !candidates.has(id));
    if (ids.length === 0 || ids.length > 5)
        return { seats: ROLES.map(openSeat), infeasible: false, ids };
    if (input.denyMode === true && candidates.size > 0 && !roleGap(ids).feasible) {
        // The opponent's own picks seated as usual; each banned champion overlaid where it would
        // most likely have played — a filled seat shows the count badge, never a red row. The
        // baseline never contains a candidate (a caller passing an overlapping beforeIds would
        // otherwise count it twice).
        const base = seatPlan({ ids: beforeIds.filter((id) => !candidates.has(id)) });
        for (const id of ids.filter((c) => candidates.has(c))) {
            const seat = base.seats[ROLES.indexOf(bestPlayableSeat(id))];
            seat.count += 1;
            seat.occupant = id;
            seat.marker = "candidate";
            seat.dist = seatMarginals([id]).get(id) ?? null;
        }
        return { seats: base.seats, infeasible: base.infeasible, ids };
    }
    if (!roleGap(ids).feasible) {
        const seats = ROLES.map(openSeat);
        for (const id of ids) {
            const seat = seats[ROLES.indexOf(bestPlayableSeat(id))];
            seat.count += 1;
            seat.marker = "infeasible";
            if (seat.occupant === null) seat.occupant = id;
        }
        return { seats, infeasible: true, ids };
    }
    const seating = topSeating(ids);
    const marginals = seatMarginals(ids);
    const moved = new Set(seatMoves(beforeIds, ids).map((m) => m.championId));
    const seats = ROLES.map((role): Seat => {
        const occupant = seating?.[role] ?? null;
        if (occupant === null) return openSeat(role);
        const marker: SeatMarker = candidates.has(occupant)
            ? "candidate"
            : moved.has(occupant)
              ? "moved"
              : "none";
        return {
            role,
            occupant,
            count: 1,
            marker,
            dist: marginals.get(occupant) ?? null
        };
    });
    return { seats, infeasible: false, ids };
}

/** CSS conic-gradient of the five role colours in ROLES order, each arc = the marginal; arcs
 *  below RING_MIN_ARC are skipped; "" when nothing is drawable. */
export function ringGradient(dist: RoleDist): string {
    const stops: string[] = [];
    let acc = 0;
    for (const role of ROLES) {
        const v = dist[role];
        if (v < RING_MIN_ARC) continue;
        const from = (acc * 100).toFixed(1);
        acc += v;
        stops.push(`${ROLE_HEX[role]} ${from}% ${(acc * 100).toFixed(1)}%`);
    }
    return stops.length === 0 ? "" : `conic-gradient(${stops.join(", ")})`;
}

/** "Brand: sup 43%, adc 23%, mid 17%" — roles ≥ TITLE_MIN, most likely first. */
export function ringTitle(name: string, dist: RoleDist): string {
    const parts = ROLES.filter((r) => dist[r] >= TITLE_MIN)
        .sort(byMarginalThenRoleOrder(dist))
        .map(
            (r) => `${ROLE_SHORT_LABELS[r].toLowerCase()} ${Math.round(dist[r] * 100)}%`
        );
    return `${name}: ${parts.join(", ")}`;
}

export interface LikelyRole {
    role: Role;
    pct: number;
}

/** The two most likely roles ≥ NOTE_MIN, ties by ROLES order (design § 3 pick-row note). */
export function likelyRoles(dist: RoleDist): LikelyRole[] {
    return ROLES.filter((r) => dist[r] >= NOTE_MIN)
        .sort(byMarginalThenRoleOrder(dist))
        .slice(0, 2)
        .map((role) => ({ role, pct: Math.round(dist[role] * 100) }));
}

/** "Sup 72% · Top 11%" (the team column renders the role words in their colours itself). */
export function likelyRolesNote(dist: RoleDist): string {
    return likelyRoles(dist)
        .map(({ role, pct }) => `${ROLE_SHORT_LABELS[role]} ${pct}%`)
        .join(" · ");
}

/** The roles summary's text on an infeasible side (plan-level decision 11). */
export function infeasibleSummary(
    ids: readonly string[],
    nameOf: (id: string) => string
): string {
    return `✕ cannot fill five roles with ${uniq(ids).map(nameOf).join(", ")}`;
}
