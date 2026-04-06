function getPostCompletionEditWindowSeconds(versusDraft) {
  return versusDraft?.competitive ? 900 : 5400;
}

function getWinnerReportingWindowSeconds(versusDraft) {
  return versusDraft?.competitive ? 5400 : 32400;
}

function hasDraftStarted(draft) {
  if (!draft) return false;
  if (draft.completed) return true;

  return (draft.picks || []).some((pick) => pick && pick !== "");
}

function getPostCompletionWindowState(completedAt, versusDraft, windowSeconds) {
  const resolvedWindowSeconds =
    windowSeconds ?? getPostCompletionEditWindowSeconds(versusDraft);

  if (!completedAt) {
    return {
      windowSeconds: resolvedWindowSeconds,
      expiresAt: null,
      isExpired: false,
    };
  }

  const completedAtMs = new Date(completedAt).getTime();
  const expiresAt = completedAtMs + resolvedWindowSeconds * 1000;

  return {
    windowSeconds: resolvedWindowSeconds,
    expiresAt,
    isExpired: Date.now() > expiresAt,
  };
}

function hasNewerStartedDraft(versusDraft, targetDraftId) {
  const drafts = versusDraft?.Drafts || [];
  const draftIndex = drafts.findIndex((draft) => draft.id === targetDraftId);
  if (draftIndex < 0) return false;

  return drafts.slice(draftIndex + 1).some((draft) => hasDraftStarted(draft));
}

function getDraftEditLockState(targetDraft, versusDraft) {
  const windowState = getPostCompletionWindowState(
    targetDraft?.completedAt,
    versusDraft,
    getPostCompletionEditWindowSeconds(versusDraft),
  );
  const blockedByNewerDraft = hasNewerStartedDraft(versusDraft, targetDraft?.id);

  return {
    ...windowState,
    blockedByNewerDraft,
    isLocked: blockedByNewerDraft || windowState.isExpired,
  };
}

function getWinnerReportingLockState(targetDraft, versusDraft) {
  const windowState = getPostCompletionWindowState(
    targetDraft?.completedAt,
    versusDraft,
    getWinnerReportingWindowSeconds(versusDraft),
  );
  const blockedByNewerDraft = hasNewerStartedDraft(versusDraft, targetDraft?.id);

  return {
    ...windowState,
    blockedByNewerDraft,
    isLocked: blockedByNewerDraft || windowState.isExpired,
  };
}

function getSeriesWins(versusDraft) {
  const drafts = versusDraft?.Drafts || [];

  return drafts.reduce(
    (score, draft) => {
      if (!draft.winner) return score;

      const blueSideTeam = draft.blueSideTeam || 1;
      const team1Won =
        (draft.winner === "blue" && blueSideTeam === 1) ||
        (draft.winner === "red" && blueSideTeam === 2);

      if (team1Won) {
        score.team1 += 1;
      } else {
        score.team2 += 1;
      }

      return score;
    },
    { team1: 0, team2: 0 },
  );
}

function isSeriesConcluded(versusDraft) {
  const drafts = versusDraft?.Drafts || [];
  if (drafts.length === 0) return false;

  if (drafts.every((draft) => draft.completed)) {
    return true;
  }

  const winsNeeded = Math.ceil((versusDraft?.length || drafts.length || 1) / 2);
  const { team1, team2 } = getSeriesWins(versusDraft);

  return team1 >= winsNeeded || team2 >= winsNeeded;
}

function getLatestCompletedDraft(versusDraft) {
  const drafts = versusDraft?.Drafts || [];

  return drafts.reduce((latestDraft, draft) => {
    if (!draft.completed) return latestDraft;
    if (!latestDraft) return draft;

    const draftSeriesIndex = draft.seriesIndex ?? -1;
    const latestSeriesIndex = latestDraft.seriesIndex ?? -1;

    return draftSeriesIndex > latestSeriesIndex ? draft : latestDraft;
  }, null);
}

function getCaptainRoleLockState(versusDraft) {
  if (!isSeriesConcluded(versusDraft)) {
    return {
      isLocked: false,
      latestCompletedDraft: null,
      expiresAt: null,
      windowSeconds: getPostCompletionEditWindowSeconds(versusDraft),
    };
  }

  const latestCompletedDraft = getLatestCompletedDraft(versusDraft);
  if (!latestCompletedDraft?.completedAt) {
    return {
      isLocked: false,
      latestCompletedDraft,
      expiresAt: null,
      windowSeconds: getPostCompletionEditWindowSeconds(versusDraft),
    };
  }

  const windowState = getPostCompletionWindowState(
    latestCompletedDraft.completedAt,
    versusDraft,
    getPostCompletionEditWindowSeconds(versusDraft),
  );

  return {
    ...windowState,
    latestCompletedDraft,
    isLocked: windowState.isExpired,
  };
}

module.exports = {
  getPostCompletionEditWindowSeconds,
  getWinnerReportingWindowSeconds,
  getPostCompletionWindowState,
  getDraftEditLockState,
  getWinnerReportingLockState,
  getCaptainRoleLockState,
};
