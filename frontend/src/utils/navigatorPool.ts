import type { TeamPool, RolePoolMap } from "@draft-sim/shared-types";

export type PickerState =
    | "picked"        // already banned or picked in the draft
    | "own-team"      // in the current turn's team display pool only
    | "other-team"    // in the other team's display pool only
    | "shared"        // in both teams' display pools
    | "neutral";      // in neither team's display pool

// Returns true if a champion ID is in any role list of a team's display pool.
export function isInTeamDisplay(
    championId: string,
    teamPool: TeamPool
): boolean {
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
