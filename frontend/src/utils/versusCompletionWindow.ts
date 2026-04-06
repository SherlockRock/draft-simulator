import type { VersusDraft } from "./schemas";

export function getVersusPostCompletionEditWindowSeconds(competitive: boolean): number {
    return competitive ? 900 : 5400;
}

export function getVersusWinnerReportingWindowSeconds(competitive: boolean): number {
    return competitive ? 5400 : 32400;
}

export function getCompletionWindowState(
    completedAt: string | null | undefined,
    windowSeconds: number
): {
    expiresAt: number | null;
    isExpired: boolean;
} {
    if (!completedAt) {
        return {
            expiresAt: null,
            isExpired: false
        };
    }

    const expiresAt = new Date(completedAt).getTime() + windowSeconds * 1000;

    return {
        expiresAt,
        isExpired: Date.now() > expiresAt
    };
}

export function hasVersusDraftStarted(
    draft: NonNullable<VersusDraft["Drafts"]>[number] | null | undefined
): boolean {
    if (!draft) return false;
    if (draft.completed) return true;

    return (draft.picks || []).some((pick) => pick && pick !== "");
}

function getSeriesScore(versusDraft: VersusDraft): { team1: number; team2: number } {
    return (versusDraft.Drafts || []).reduce(
        (score, draft) => {
            if (!draft.winner) return score;

            const blueSideTeam = draft.blueSideTeam || 1;
            const team1Won =
                (draft.winner === "blue" && blueSideTeam === 1) ||
                (draft.winner === "red" && blueSideTeam === 2);

            if (team1Won) score.team1 += 1;
            else score.team2 += 1;

            return score;
        },
        { team1: 0, team2: 0 }
    );
}

export function isVersusSeriesConcluded(
    versusDraft: VersusDraft | null | undefined
): boolean {
    if (!versusDraft) return false;

    const drafts = versusDraft.Drafts || [];
    if (drafts.length === 0) return false;

    if (drafts.every((draft) => draft.completed)) {
        return true;
    }

    const winsNeeded = Math.ceil((versusDraft.length || drafts.length || 1) / 2);
    const { team1, team2 } = getSeriesScore(versusDraft);

    return team1 >= winsNeeded || team2 >= winsNeeded;
}

export function getLatestCompletedDraft(versusDraft: VersusDraft | null | undefined) {
    if (!versusDraft) return null;

    return (versusDraft.Drafts || []).reduce(
        (latestDraft, draft) => {
            if (!draft.completed) return latestDraft;
            if (!latestDraft) return draft;

            const draftSeriesIndex = draft.seriesIndex ?? -1;
            const latestSeriesIndex = latestDraft.seriesIndex ?? -1;

            return draftSeriesIndex > latestSeriesIndex ? draft : latestDraft;
        },
        null as NonNullable<VersusDraft["Drafts"]>[number] | null
    );
}

export function hasNewerStartedDraft(
    versusDraft: VersusDraft | null | undefined,
    targetDraftId: string | null | undefined
): boolean {
    if (!versusDraft || !targetDraftId) return false;

    const drafts = versusDraft.Drafts || [];
    const draftIndex = drafts.findIndex((draft) => draft.id === targetDraftId);
    if (draftIndex < 0) return false;

    return drafts.slice(draftIndex + 1).some((draft) => hasVersusDraftStarted(draft));
}

export function isDraftEditLocked(
    targetDraft: NonNullable<VersusDraft["Drafts"]>[number] | null | undefined,
    versusDraft: VersusDraft | null | undefined
): boolean {
    if (!targetDraft?.completed) return false;

    if (hasNewerStartedDraft(versusDraft, targetDraft.id)) {
        return true;
    }

    const windowSeconds = getVersusPostCompletionEditWindowSeconds(
        versusDraft?.competitive ?? false
    );

    return getCompletionWindowState(targetDraft.completedAt, windowSeconds).isExpired;
}

export function isWinnerReportingLocked(
    targetDraft: NonNullable<VersusDraft["Drafts"]>[number] | null | undefined,
    versusDraft: VersusDraft | null | undefined
): boolean {
    if (!targetDraft?.completed) return false;

    const windowSeconds = getVersusWinnerReportingWindowSeconds(
        versusDraft?.competitive ?? false
    );

    return getCompletionWindowState(targetDraft.completedAt, windowSeconds).isExpired;
}

export function isCaptainRoleReselectLocked(
    versusDraft: VersusDraft | null | undefined
): boolean {
    if (!versusDraft || !isVersusSeriesConcluded(versusDraft)) {
        return false;
    }

    const latestCompletedDraft = getLatestCompletedDraft(versusDraft);
    if (!latestCompletedDraft?.completedAt) {
        return false;
    }

    const windowSeconds = getVersusPostCompletionEditWindowSeconds(
        versusDraft.competitive ?? false
    );

    return getCompletionWindowState(latestCompletedDraft.completedAt, windowSeconds)
        .isExpired;
}
