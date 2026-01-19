const { getActiveDraftIds, getState } = require("./versusStateManager");
const { processPickLock } = require("../socketHandlers/versusHandlers");
const { VERSUS_PICK_ORDER } = require("../utils/versusPickOrder");

const PICK_TIMER_DURATION = 30000; // 30 seconds in milliseconds

let timerInterval = null;
let io = null;
let cleanupCounter = 0;

/**
 * Initialize the timer service with Socket.IO instance
 * @param {Object} socketIo - Socket.IO server instance
 */
function initializeTimerService(socketIo) {
  io = socketIo;

  // Start timer check interval (runs every second)
  if (!timerInterval) {
    timerInterval = setInterval(checkTimers, 1000);
    console.log("Versus timer service started");
  }
}

/**
 * Check all active drafts for timer expiry
 */
async function checkTimers() {
  if (!io) return;

  const activeDraftIds = getActiveDraftIds();

  for (const draftId of activeDraftIds) {
    const state = getState(draftId);

    if (!state || state.isPaused || !state.timerStartedAt) {
      continue;
    }

    // Check if timer has expired
    const elapsed = Date.now() - state.timerStartedAt;

    if (elapsed >= PICK_TIMER_DURATION) {
      // Timer expired - auto-lock current pick
      const currentPick = VERSUS_PICK_ORDER[state.currentPickIndex];

      if (currentPick) {
        console.log(
          `Timer expired for draft ${draftId}, auto-locking for team ${currentPick.team}`
        );
        console.log(`Hovered champions:`, state.hoveredChampions);
        await processPickLock(io, draftId, currentPick.team);
      }
    }
  }
}

/**
 * Stop the timer service
 */
function stopTimerService() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
    console.log("Versus timer service stopped");
  }
}

module.exports = {
  initializeTimerService,
  stopTimerService,
};
