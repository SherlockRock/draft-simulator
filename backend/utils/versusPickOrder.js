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
 * Returns the pick order with teams swapped when firstPick is "red".
 * When firstPick is "blue" (default), returns the standard order unchanged.
 * @param {string} firstPick - "blue" or "red"
 * @returns {Array} - The effective pick order
 */
function getEffectivePickOrder(firstPick = "blue") {
  if (firstPick === "blue") return VERSUS_PICK_ORDER;
  return VERSUS_PICK_ORDER.map((item) => ({
    ...item,
    team: item.team === "blue" ? "red" : "blue",
  }));
}

/**
 * Maps a current pick index to the corresponding index in the Draft.picks array
 * @param {number} currentPickIndex - Index in VERSUS_PICK_ORDER (0-19)
 * @param {string} firstPick - "blue" or "red"
 * @returns {number} - Index in Draft.picks array (0-19)
 */
function getPicksArrayIndex(currentPickIndex, firstPick = "blue") {
  const effectiveOrder = getEffectivePickOrder(firstPick);
  const currentPick = effectiveOrder[currentPickIndex];
  const { team, type, slot } = currentPick;

  let picksIndex;

  if (type === "ban") {
    picksIndex = team === "blue" ? slot : slot + 5;
  } else {
    picksIndex = team === "blue" ? slot + 10 : slot + 15;
  }

  return picksIndex;
}

/**
 * Reverse mapping: given picks array, determine current pick index
 * Counts non-empty picks to determine where we are in the draft
 * @param {Array<string>} picks - Draft.picks array
 * @param {string} firstPick - "blue" or "red"
 * @returns {number} - Next pick to make (index in VERSUS_PICK_ORDER)
 */
function getCurrentPickIndexFromPicks(picks, firstPick = "blue") {
  if (!picks || !Array.isArray(picks)) return 0;

  const effectiveOrder = getEffectivePickOrder(firstPick);

  for (let i = 0; i < effectiveOrder.length; i++) {
    const picksIndex = getPicksArrayIndex(i, firstPick);
    if (picks[picksIndex] && picks[picksIndex] !== "") {
      continue;
    } else {
      return i;
    }
  }

  return effectiveOrder.length; // Draft complete if = 20
}

module.exports = {
  VERSUS_PICK_ORDER,
  getEffectivePickOrder,
  getPicksArrayIndex,
  getCurrentPickIndexFromPicks,
};
