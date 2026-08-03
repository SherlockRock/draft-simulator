import type { CanvasDraft, CanvasGroup } from "./schemas";

/**
 * The two card columns are physical SIDES, not fixed rosters: picks[0-4] and
 * picks[10-14] are the blue-side ban/pick slots and render on the left.
 * `blueSideTeam` says which team identity occupies blue. So we resolve identity
 * first, then map identity onto columns.
 *
 * The group's `blueTeamName`/`redTeamName` metadata keys are misnomers — they
 * hold team1/team2 IDENTITY, which is exactly why they need this mapping.
 *
 * Precedence (card override → linked Team entity → group metadata) matches
 * resolveGroupTeamNames in canvasSearch.ts, so the card, the full-screen view
 * and the search filter finally agree on what a team is called.
 */
export const resolveTeamNames = (
    canvasDraft: CanvasDraft,
    group?: CanvasGroup
): { left?: string; right?: string } => {
    const identity = {
        team1:
            canvasDraft.team1Name?.trim() ||
            group?.Team1?.name?.trim() ||
            group?.metadata.blueTeamName?.trim() ||
            undefined,
        team2:
            canvasDraft.team2Name?.trim() ||
            group?.Team2?.name?.trim() ||
            group?.metadata.redTeamName?.trim() ||
            undefined
    };
    const bst = canvasDraft.Draft.blueSideTeam ?? 1;
    return bst === 1
        ? { left: identity.team1, right: identity.team2 }
        : { left: identity.team2, right: identity.team1 };
};

/**
 * Which CanvasDraft column a given card column writes to. The left column is
 * team1 only when team1 is on blue side. Callers must snapshot this on FOCUS,
 * not on blur: a collaborator can swap blueSideTeam mid-edit, which would
 * otherwise write the text to the opposite team.
 */
export const fieldForColumn = (
    column: "left" | "right",
    blueSideTeam: 1 | 2 | undefined
): "team1Name" | "team2Name" => {
    const bst = blueSideTeam ?? 1;
    if (column === "left") return bst === 1 ? "team1Name" : "team2Name";
    return bst === 1 ? "team2Name" : "team1Name";
};
