/**
 * Derive the user's side for a specific game within a Navigator series.
 *
 * Precedence:
 *   1. draft.our_side_override (if set, wins unconditionally)
 *   2. session.side_swap_mode === "manual" -> defaults to session.our_side
 *      (manual override not yet set — caller should collect it before starting
 *      the game and write it back to the draft as our_side_override)
 *   3. session.side_swap_mode === "auto" -> alternate from Game 1
 *
 * @param {{ our_side: "blue" | "red", side_swap_mode: "auto" | "manual" }} session
 * @param {{ game_number: number, our_side_override?: "blue" | "red" | null }} draft
 * @returns {"blue" | "red"}
 */
function getOurSideForGame(session, draft) {
  if (draft && draft.our_side_override) {
    return draft.our_side_override;
  }

  if (session.side_swap_mode === "manual") {
    return session.our_side;
  }

  const gameIndex = (draft && draft.game_number ? draft.game_number : 1) - 1;
  const baseSide = session.our_side;
  if (gameIndex % 2 === 0) return baseSide;
  return baseSide === "blue" ? "red" : "blue";
}

module.exports = { getOurSideForGame };
