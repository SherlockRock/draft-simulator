/**
 * Get champions restricted from selection based on group draft mode
 * and picks across all other drafts in the group.
 *
 * Unlike series restrictions (which use ordering), group restrictions
 * are symmetric — any champion used in any other draft in the group
 * is restricted in the current draft.
 *
 * Picks array layout:
 * - Indices 0-4: Blue bans
 * - Indices 5-9: Red bans
 * - Indices 10-14: Blue picks
 * - Indices 15-19: Red picks
 *
 * @param {string} draftMode - 'standard', 'fearless', or 'ironman'
 * @param {Array} drafts - Array of draft objects with picks arrays
 * @param {string} currentDraftId - The ID of the current draft to exclude
 * @returns {string[]} Array of champion IDs that are restricted
 */
function getGroupRestrictedChampions(draftMode, drafts, currentDraftId) {
  if (draftMode === "standard" || !draftMode) {
    return [];
  }

  const restricted = [];

  for (const draft of drafts) {
    if (draft.id === currentDraftId) continue;

    const picks = draft.picks || [];

    if (draftMode === "fearless") {
      // Picks only: indices 10-19
      for (let i = 10; i < 20; i++) {
        if (picks[i] && picks[i] !== "") {
          restricted.push(picks[i]);
        }
      }
    } else if (draftMode === "ironman") {
      // Picks and bans: indices 0-19
      for (let i = 0; i < 20; i++) {
        if (picks[i] && picks[i] !== "") {
          restricted.push(picks[i]);
        }
      }
    }
  }

  return [...new Set(restricted)]; // dedupe
}

module.exports = { getGroupRestrictedChampions };
