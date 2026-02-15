import { draft, VersusDraft } from "./schemas";

export function canReportWinner(
    targetDraft: draft,
    versusDraft: VersusDraft,
    myRole: "blue_captain" | "red_captain" | "spectator" | null,
    userId: string | null
): boolean {
    // Must be completed to report winner
    if (!targetDraft.completed) return false;

    const drafts = versusDraft.Drafts || [];
    const draftIndex = drafts.findIndex((d) => d.id === targetDraft.id);

    // Check if there's a newer completed draft
    const hasNewerCompletedDraft = drafts.slice(draftIndex + 1).some((d) => d.completed);

    const isCaptain = myRole === "blue_captain" || myRole === "red_captain";
    const isOwner = userId === versusDraft.owner_id;

    // Past games: owner only. Current game: captains or owner.
    return hasNewerCompletedDraft ? isOwner : isCaptain || isOwner;
}
