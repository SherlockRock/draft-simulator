/**
 * Get champions restricted from selection based on series type and previous games.
 *
 * Picks array layout:
 * - Indices 0-4: Blue bans
 * - Indices 5-9: Red bans
 * - Indices 10-14: Blue picks
 * - Indices 15-19: Red picks
 *
 * @param {string} seriesType - 'standard', 'fearless', or 'ironman'
 * @param {Array} drafts - Array of draft objects with picks arrays
 * @param {number} currentSeriesIndex - The seriesIndex of the current game
 * @returns {string[]} Array of champion IDs that are restricted
 */
function getRestrictedChampions(seriesType, drafts, currentSeriesIndex) {
  if (seriesType === 'standard') {
    return [];
  }

  const restricted = [];

  for (const draft of drafts) {
    if (draft.seriesIndex >= currentSeriesIndex) continue;

    const picks = draft.picks || [];

    if (seriesType === 'fearless') {
      // Picks only: indices 10-19
      for (let i = 10; i < 20; i++) {
        if (picks[i] && picks[i] !== '') {
          restricted.push(picks[i]);
        }
      }
    } else if (seriesType === 'ironman') {
      // Picks and bans: indices 0-19
      for (let i = 0; i < 20; i++) {
        if (picks[i] && picks[i] !== '') {
          restricted.push(picks[i]);
        }
      }
    }
  }

  return [...new Set(restricted)]; // dedupe
}

module.exports = { getRestrictedChampions };
