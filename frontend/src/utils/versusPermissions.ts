import { draft, VersusDraft } from "./schemas";

/**
 * Resolves a side ("blue"/"red") to the correct team name for the current game,
 * accounting for which team has been assigned blue side.
 */
export function getSideTeamName(
    side: "blue" | "red",
    blueSideTeam: number,
    blueTeamName: string,
    redTeamName: string
): string {
    if (side === "blue") return blueSideTeam === 1 ? blueTeamName : redTeamName;
    return blueSideTeam === 1 ? redTeamName : blueTeamName;
}

export function canReportWinner(
    targetDraft: draft,
    versusDraft: VersusDraft,
    myRole: "team1_captain" | "team2_captain" | "spectator" | null,
    userId: string | null
): boolean {
    // Must be completed to report winner
    if (!targetDraft.completed) return false;

    const drafts = versusDraft.Drafts || [];
    const draftIndex = drafts.findIndex((d) => d.id === targetDraft.id);

    // Check if there's a newer completed draft
    const hasNewerCompletedDraft = drafts.slice(draftIndex + 1).some((d) => d.completed);

    const isCaptain = myRole === "team1_captain" || myRole === "team2_captain";
    const isOwner = userId === versusDraft.owner_id;

    // Past games: owner only. Current game: captains or owner.
    return hasNewerCompletedDraft ? isOwner : isCaptain || isOwner;
}
