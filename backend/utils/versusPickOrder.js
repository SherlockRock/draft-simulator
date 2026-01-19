// Versus draft pick order: 6 bans, 6 picks, 4 bans, 4 picks (20 total)
// Matches League of Legends competitive draft format
const VERSUS_PICK_ORDER = [
  // Phase 1: Blue ban, Red ban (3 each, alternating)
  { team: "blue", type: "ban", slot: 0 },
  { team: "red", type: "ban", slot: 0 },
  { team: "blue", type: "ban", slot: 1 },
  { team: "red", type: "ban", slot: 1 },
  { team: "blue", type: "ban", slot: 2 },
  { team: "red", type: "ban", slot: 2 },

  // Phase 2: Blue pick, Red pick (3 each, alternating - but red starts with double pick)
  { team: "blue", type: "pick", slot: 0 },
  { team: "red", type: "pick", slot: 0 },
  { team: "red", type: "pick", slot: 1 },
  { team: "blue", type: "pick", slot: 1 },
  { team: "blue", type: "pick", slot: 2 },
  { team: "red", type: "pick", slot: 2 },

  // Phase 3: Red ban, Blue ban (2 each, alternating)
  { team: "red", type: "ban", slot: 3 },
  { team: "blue", type: "ban", slot: 3 },
  { team: "red", type: "ban", slot: 4 },
  { team: "blue", type: "ban", slot: 4 },

  // Phase 4: Red pick, Blue pick (2 each, alternating - red starts with double pick)
  { team: "red", type: "pick", slot: 3 },
  { team: "blue", type: "pick", slot: 3 },
  { team: "blue", type: "pick", slot: 4 },
  { team: "red", type: "pick", slot: 4 },
]; // Total: 20 items

/**
 * Maps a current pick index to the corresponding index in the Draft.picks array
 * @param {number} currentPickIndex - Index in VERSUS_PICK_ORDER (0-19)
 * @returns {number} - Index in Draft.picks array (0-19)
 */
function getPicksArrayIndex(currentPickIndex) {
  const currentPick = VERSUS_PICK_ORDER[currentPickIndex];
  const { team, type, slot } = currentPick;

  let picksIndex;

  if (type === "ban") {
    // Bans: picks[0-9]
    // Blue bans: 0-4, Red bans: 5-9
    picksIndex = team === "blue" ? slot : slot + 5;
  } else {
    // Picks: picks[10-19]
    // Blue picks: 10-14, Red picks: 15-19
    picksIndex = team === "blue" ? slot + 10 : slot + 15;
  }

  return picksIndex;
}

/**
 * Reverse mapping: given picks array, determine current pick index
 * Counts non-empty picks to determine where we are in the draft
 * @param {Array<string>} picks - Draft.picks array
 * @returns {number} - Next pick to make (index in VERSUS_PICK_ORDER)
 */
function getCurrentPickIndexFromPicks(picks) {
  if (!picks || !Array.isArray(picks)) return 0;

  let filledCount = 0;

  // Count filled picks by iterating through VERSUS_PICK_ORDER
  for (let i = 0; i < VERSUS_PICK_ORDER.length; i++) {
    const picksIndex = getPicksArrayIndex(i);
    if (picks[picksIndex] && picks[picksIndex] !== "") {
      filledCount++;
    } else {
      // First empty slot found
      return i;
    }
  }

  return filledCount; // Draft complete if = 20
}

module.exports = {
  VERSUS_PICK_ORDER,
  getPicksArrayIndex,
  getCurrentPickIndexFromPicks,
};
