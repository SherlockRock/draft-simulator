import type { TeamPool, RolePoolMap, Role } from "@draft-sim/shared-types";
import { ROLES, championsInRole, getChampionRoles } from "./championRoles";

export type PickerState =
    | "picked" // already banned or picked in the draft
    | "own-team" // in the current turn's team display pool only
    | "other-team" // in the other team's display pool only
    | "shared" // in both teams' display pools
    | "neutral"; // in neither team's display pool

// Returns true if a champion ID is in any role list of a team's display pool.
export function isInTeamDisplay(championId: string, teamPool: TeamPool): boolean {
    const display = teamPool.display;
    return (
        display.top.includes(championId) ||
        display.jungle.includes(championId) ||
        display.mid.includes(championId) ||
        display.adc.includes(championId) ||
        display.support.includes(championId)
    );
}

// Compute the flat union of all champions in a display pool (across roles).
export function flattenDisplayPool(display: RolePoolMap): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const role of ["top", "jungle", "mid", "adc", "support"] as const) {
        for (const id of display[role]) {
            if (!seen.has(id)) {
                seen.add(id);
                out.push(id);
            }
        }
    }
    return out;
}

// Derive the picker state for one champion given current turn side and
// both teams' pools + the set of champions already used in the draft.
export function getPickerState(
    championId: string,
    currentTurnSide: "blue" | "red" | null,
    bluePool: TeamPool,
    redPool: TeamPool,
    usedChampionIds: Set<string>
): PickerState {
    if (usedChampionIds.has(championId)) return "picked";

    const inBlue = isInTeamDisplay(championId, bluePool);
    const inRed = isInTeamDisplay(championId, redPool);

    if (inBlue && inRed) return "shared";
    if (!inBlue && !inRed) return "neutral";

    // Exactly one team has it.
    if (currentTurnSide === "blue") {
        return inBlue ? "own-team" : "other-team";
    }
    if (currentTurnSide === "red") {
        return inRed ? "own-team" : "other-team";
    }
    // No current turn (draft complete) — disambiguate by which team has it.
    return inBlue ? "own-team" : "other-team";
}

export interface StaleBucketEntry {
    championId: string;
    role: Role;
    /** stale-in: bucketed under a role the champion no longer lists.
     *  stale-out: lists a role it is not bucketed under. */
    kind: "stale-in" | "stale-out";
}

/** The champion set a pool carries: every display bucket plus `search`.
 *  Both detection and re-bucketing use this set so the fix is idempotent. */
function poolChampionSet(pool: TeamPool): Set<string> {
    return new Set([...flattenDisplayPool(pool.display), ...pool.search]);
}

/** Design § 7 detection, against champions.json positions. */
export function detectStaleBuckets(pool: TeamPool): StaleBucketEntry[] {
    const out: StaleBucketEntry[] = [];
    for (const role of ROLES) {
        for (const championId of pool.display[role]) {
            if (!getChampionRoles(championId).includes(role))
                out.push({ championId, role, kind: "stale-in" });
        }
    }
    for (const championId of poolChampionSet(pool)) {
        for (const role of getChampionRoles(championId)) {
            if (!pool.display[role].includes(championId))
                out.push({ championId, role, kind: "stale-out" });
        }
    }
    return out;
}

/** Design § 7 migration: keep the champion set, re-derive `display[role]` =
 *  set ∩ championsInRole(role) — champions already in the bucket keep their
 *  order, newly qualifying ones follow in roster order; `search` unchanged.
 *  Not Setup's "Load defaults" (`getDefaultRolePoolMap` = the full roster). */
export function rebucketDisplay(pool: TeamPool): TeamPool {
    const set = poolChampionSet(pool);
    const display: RolePoolMap = { top: [], jungle: [], mid: [], adc: [], support: [] };
    for (const role of ROLES) {
        const inRole = new Set(championsInRole(role).filter((id) => set.has(id)));
        const kept = pool.display[role].filter((id) => inRole.has(id));
        const added = [...inRole].filter((id) => !kept.includes(id));
        display[role] = [...kept, ...added];
    }
    return { display, search: pool.search };
}

/** "Vayne: adc → top, adc" per stale champion, name-sorted (the palette's
 *  `rebucket` preview and the pill's tooltip). */
export function staleBucketSummary(
    pool: TeamPool,
    nameOf: (id: string) => string
): string[] {
    const stale = new Set(detectStaleBuckets(pool).map((e) => e.championId));
    return [...stale]
        .map((id) => {
            const current = ROLES.filter((role) => pool.display[role].includes(id));
            const listed = getChampionRoles(id);
            return `${nameOf(id)}: ${current.length > 0 ? current.join(", ") : "—"} → ${listed.join(", ")}`;
        })
        .sort((a, b) => a.localeCompare(b));
}
