const { getCurrentPickIndexFromPicks } = require("../utils/versusPickOrder");

// In-memory state storage for active versus drafts
// Maps draftId -> state object
const versusStates = new Map();

/**
 * Initialize or get state for a versus draft
 * @param {string} draftId - Draft UUID
 * @param {Array<string>} picks - Current picks array from database
 * @returns {Object} - State object
 */
function initializeState(draftId, picks = [], firstPick = "blue") {
  if (versusStates.has(draftId)) {
    return versusStates.get(draftId);
  }

  const currentPickIndex = getCurrentPickIndexFromPicks(picks, firstPick);

  const state = {
    draftId,
    currentPickIndex,
    firstPick,
    timerStartedAt: null,
    isPaused: false,
    pauseRequestedBy: null,
    resumeRequestedBy: null,
    pausedTimeRemaining: null, // Time remaining when paused (in ms)
    isCountingDown: false,
    countdownStartedAt: null,
    readyStatus: {
      blue: false,
      red: false,
    },
    hoveredChampions: {
      blue: null,
      red: null,
    },
    pickChangeRequests: [],
  };

  versusStates.set(draftId, state);
  return state;
}

/**
 * Get state for a draft (without initializing if not exists)
 * @param {string} draftId - Draft UUID
 * @returns {Object|null} - State object or null
 */
function getState(draftId) {
  return versusStates.get(draftId) || null;
}

/**
 * Update state for a draft
 * @param {string} draftId - Draft UUID
 * @param {Object} updates - Partial state updates
 */
function updateState(draftId, updates) {
  const state = versusStates.get(draftId);
  if (state) {
    Object.assign(state, updates);
  }
}

/**
 * Remove state for a draft (cleanup)
 * @param {string} draftId - Draft UUID
 */
function removeState(draftId) {
  versusStates.delete(draftId);
}

/**
 * Get all active draft IDs
 * @returns {Array<string>}
 */
function getActiveDraftIds() {
  return Array.from(versusStates.keys());
}

/**
 * Reset ready status for a draft
 * @param {string} draftId - Draft UUID
 */
function resetReadyStatus(draftId) {
  const state = versusStates.get(draftId);
  if (state) {
    state.readyStatus = { blue: false, red: false };
  }
}

module.exports = {
  initializeState,
  getState,
  getActiveDraftIds,
};
