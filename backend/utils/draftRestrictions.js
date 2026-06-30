const { getGroupRestrictedChampions } = require("./groupRestrictions");
const { getRestrictedChampions } = require("./seriesRestrictions");

/**
 * Resolve restricted champions for a draft inside a canvas group, dispatching to
 * the correct restriction model based on the group type.
 *
 * - Series groups are ORDERED: only games with a lower seriesIndex restrict the
 *   current game (so editing an earlier game is never blocked by a later one).
 * - Custom groups are SYMMETRIC: any champion used in any other draft is
 *   restricted.
 *
 * Keeping this dispatch in one place ensures the backend's validation matches
 * the frontend (DraftDetailView uses series vs group restrictions the same way).
 *
 * @param {Object} params
 * @param {string} params.groupType - CanvasGroup.type ("series" or "custom")
 * @param {string|undefined} params.seriesType - 'standard' | 'fearless' | 'ironman'
 * @param {string|undefined} params.draftMode - 'standard' | 'fearless' | 'ironman'
 * @param {Array} params.drafts - Drafts in the group ({ id, picks, seriesIndex })
 * @param {string} params.currentDraftId - The draft being edited
 * @param {number} params.currentSeriesIndex - seriesIndex of the draft being edited
 * @returns {string[]} Restricted champion IDs
 */
function getRestrictedChampionsForGroup({
  groupType,
  seriesType,
  draftMode,
  drafts,
  currentDraftId,
  currentSeriesIndex,
}) {
  if (groupType === "series") {
    return getRestrictedChampions(seriesType, drafts, currentSeriesIndex);
  }
  return getGroupRestrictedChampions(draftMode, drafts, currentDraftId);
}

module.exports = { getRestrictedChampionsForGroup };
