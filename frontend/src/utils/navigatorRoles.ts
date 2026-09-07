import type { Role } from "@draft-sim/shared-types";
import type {
    NavigatorRoleAssignment,
    NavigatorWeightedAssignment
} from "../contexts/NavigatorContext";
import { ROLES, getChampionRoles } from "./championRoles";

// Frontend port of packages/engine-core/src/role_solver.rs (`solve`,
// `position_factor`) and feasibility.rs (perfect matching over LISTED roles).
// The three constants MUST equal PRIMARY_FACTOR / SECONDARY_FACTOR /
// NON_LISTED_FACTOR in role_solver.rs. navigatorRoles.test.ts pins this port
// against persisted engine output, so a change on either side fails loudly.
export const PRIMARY_FACTOR = 1.0;
export const SECONDARY_FACTOR = 0.4;
export const NON_LISTED_FACTOR = 0.01;

export const ROLE_SHORT_LABELS: Record<Role, string> = {
    top: "Top",
    jungle: "Jg",
    mid: "Mid",
    adc: "ADC",
    support: "Sup"
};

const ASSIGNMENT_KEY: Record<Role, keyof NavigatorRoleAssignment> = {
    top: "TOP",
    jungle: "JUNGLE",
    mid: "MIDDLE",
    adc: "ADC",
    support: "SUPPORT"
};

export function positionFactor(role: Role, positions: readonly Role[]): number {
    if (positions[0] === role) return PRIMARY_FACTOR;
    if (positions.includes(role)) return SECONDARY_FACTOR;
    return NON_LISTED_FACTOR;
}

/** role_solver.rs `permute_choose`: ordered k-selections of `items`, items in
 *  order, the chosen item removed for the recursion. Same enumeration order
 *  as the engine, so "first max" ties resolve identically. */
function permuteChoose(
    items: readonly number[],
    k: number,
    current: number[],
    out: number[][]
): void {
    if (k === 0) {
        out.push([...current]);
        return;
    }
    for (let i = 0; i < items.length; i++) {
        current.push(items[i]);
        permuteChoose([...items.slice(0, i), ...items.slice(i + 1)], k - 1, current, out);
        current.pop();
    }
}

function emptyAssignment(): NavigatorRoleAssignment {
    return { TOP: "", JUNGLE: "", MIDDLE: "", ADC: "", SUPPORT: "" };
}

/** role_solver.rs `solve`: every P(5, n) ordered role selection for n champions,
 *  weight = ∏ positionFactor, normalised to sum 1. `[]` for 0 or > 5 champions.
 *  An unknown champion id has no listed positions (every role 0.01); the engine
 *  would panic there, the frontend degrades. */
export function solveRoles(
    championIds: readonly string[]
): NavigatorWeightedAssignment[] {
    if (championIds.length === 0 || championIds.length > 5) return [];
    const positions = championIds.map((id) => getChampionRoles(id));
    const perms: number[][] = [];
    permuteChoose([0, 1, 2, 3, 4], championIds.length, [], perms);
    const weighted = perms.map((perm) => {
        let weight = 1;
        const assignment = emptyAssignment();
        perm.forEach((roleIdx, champIdx) => {
            const role = ROLES[roleIdx];
            weight *= positionFactor(role, positions[champIdx]);
            assignment[ASSIGNMENT_KEY[role]] = championIds[champIdx];
        });
        return { assignment, weight };
    });
    const total = weighted.reduce((sum, w) => sum + w.weight, 0);
    if (total > 0) {
        for (const w of weighted) w.weight /= total;
    }
    return weighted;
}

/** Highest weight; the first one in list order on ties. Applied to the wire's
 *  assignmentDistribution too — it carries no sorted-order contract. */
function maxWeight(
    list: readonly NavigatorWeightedAssignment[]
): NavigatorWeightedAssignment | null {
    let best: NavigatorWeightedAssignment | null = null;
    for (const w of list) {
        if (best === null || w.weight > best.weight) best = w;
    }
    return best;
}

/** Highest weight; the first one in enumeration order on ties
 *  (memory project_navigator_role_solver_ties — ties are inherent). */
export function topAssignment(
    championIds: readonly string[]
): NavigatorWeightedAssignment | null {
    return maxWeight(solveRoles(championIds));
}

export function roleOf(
    assignment: NavigatorRoleAssignment,
    championId: string
): Role | null {
    for (const role of ROLES) {
        if (assignment[ASSIGNMENT_KEY[role]] === championId) return role;
    }
    return null;
}

/** Every injective assignment of the picks to LISTED roles, in pick order.
 *  Non-empty ⇔ feasibility.rs's perfect matching over `position_factor >= 0.4`
 *  exists (the 0.01 never counts — memory project_navigator_role_parity_taxonomy). */
export function listedAssignments(championIds: readonly string[]): Role[][] {
    if (championIds.length > 5) return [];
    const out: Role[][] = [];
    const current: Role[] = [];
    const used = new Set<Role>();
    const recurse = (i: number): void => {
        if (i === championIds.length) {
            out.push([...current]);
            return;
        }
        for (const role of getChampionRoles(championIds[i])) {
            if (used.has(role)) continue;
            used.add(role);
            current.push(role);
            recurse(i + 1);
            current.pop();
            used.delete(role);
        }
    };
    recurse(0);
    return out;
}

export interface RoleGap {
    feasible: boolean;
    /** Open in EVERY listed assignment. */
    must: Role[];
    /** Open in SOME listed assignment, not all. */
    maybe: Role[];
}

export function roleGap(championIds: readonly string[]): RoleGap {
    const all = listedAssignments(championIds);
    if (all.length === 0) return { feasible: false, must: [], maybe: [] };
    const must = ROLES.filter((role) => all.every((a) => !a.includes(role)));
    const maybe = ROLES.filter(
        (role) => !must.includes(role) && all.some((a) => !a.includes(role))
    );
    return { feasible: true, must, maybe };
}

export interface RoleShift {
    championId: string;
    from: Role;
    to: Role;
}

function firstShift(
    before: readonly string[],
    prev: NavigatorRoleAssignment,
    next: NavigatorRoleAssignment
): RoleShift | null {
    for (const championId of before) {
        const from = roleOf(prev, championId);
        const to = roleOf(next, championId);
        if (from && to && from !== to) return { championId, from, to };
    }
    return null;
}

/** The first earlier pick whose role differs between the top assignments of
 *  `before` and `after` (`after` = `before` plus the new pick(s)). */
export function roleShift(
    before: readonly string[],
    after: readonly string[]
): RoleShift | null {
    const prev = topAssignment(before);
    const next = topAssignment(after);
    if (!prev || !next) return null;
    return firstShift(before, prev.assignment, next.assignment);
}

export interface RoleLine {
    /** One entry per node champion, in `nodeChampionIds` order. */
    roles: (Role | null)[];
    shift: RoleShift | null;
}

function uniq(ids: readonly string[]): string[] {
    return [...new Set(ids)];
}

/** Design § 2: the role each of the node's champions takes in the top
 *  assignment of the side's picks AFTER the pick, plus the shift of an earlier
 *  pick. A non-empty `wire` (the node's assignmentDistribution) wins, reduced by
 *  max weight — the engine-emission upgrade path needs no UI change. */
export function roleLineForPick(
    sidePicksBefore: readonly string[],
    nodeChampionIds: readonly string[],
    wire: readonly NavigatorWeightedAssignment[] = [],
    confirmedChampionIds: readonly string[] = []
): RoleLine {
    const after = uniq([...sidePicksBefore, ...nodeChampionIds]);
    const top = wire.length > 0 ? maxWeight(wire) : topAssignment(after);
    if (!top) return { roles: nodeChampionIds.map(() => null), shift: null };
    const roles = nodeChampionIds.map((id) => roleOf(top.assignment, id));
    // `shift` compares a LOCAL top assignment of the earlier picks with `top`;
    // if an engine ever emits a distribution with a different tie-break the
    // amber shift could be spurious. Dead today (projection.rs:334 emits []).
    // Only the champions the node ADDS are excluded from the baseline — a
    // pair-pending node's already-confirmed half stays in `beforeOnly` so its
    // own shift (e.g. support → jungle) is still detected.
    const added = nodeChampionIds.filter((id) => !confirmedChampionIds.includes(id));
    const beforeOnly = sidePicksBefore.filter((id) => !added.includes(id));
    const prev = topAssignment(beforeOnly);
    const shift = prev ? firstShift(beforeOnly, prev.assignment, top.assignment) : null;
    return { roles, shift };
}

/** Design § 4 role-gap strip text. */
export function formatRoleGap(gap: RoleGap, pickCount: number): string {
    if (!gap.feasible) return "cannot complete five roles";
    if (pickCount === 0) return "all five open";
    const parts: string[] = [];
    if (gap.must.length > 0)
        parts.push(gap.must.map((r) => ROLE_SHORT_LABELS[r]).join(" + "));
    if (gap.maybe.length > 0)
        parts.push(gap.maybe.map((r) => ROLE_SHORT_LABELS[r]).join(" or "));
    return parts.length === 0 ? "all five covered" : parts.join(" + ");
}

/** Design § 4 `<reason>`: the first side whose picks fail the listed-roles
 *  feasibility check, named with its picks; otherwise the search-pool hint.
 *  (The engine's prune also considers the search pool; that case is the hint.) */
export function emptyFanReason(
    bluePicks: readonly string[],
    redPicks: readonly string[],
    nameOf: (id: string) => string
): string {
    const sides: { side: "blue" | "red"; picks: readonly string[] }[] = [
        { side: "blue", picks: bluePicks },
        { side: "red", picks: redPicks }
    ];
    for (const { side, picks } of sides) {
        if (picks.length > 0 && !roleGap(picks).feasible) {
            return `${side} cannot fill five roles with ${picks.map(nameOf).join(", ")}`;
        }
    }
    return "engine returned no candidates — check the search pool";
}
