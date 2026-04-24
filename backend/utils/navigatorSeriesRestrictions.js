const NavigatorDraft = require("../models/NavigatorDraft");
const NavigatorEvent = require("../models/NavigatorEvent");

/**
 * Compute the cross-game exclusion set for a Navigator series.
 *
 * Standard: empty (no prior-game exclusion)
 * Fearless: prior completed games' picks from both sides
 * Ironman:  prior completed games' picks AND bans from both sides
 *
 * Only draft events of type "pick" or "ban" count; what_if / engine_result
 * events are ignored.
 *
 * @param {{ id: string, draft_mode: "standard" | "fearless" | "ironman" }} session
 * @param {{ game_number: number }} currentDraft
 * @returns {Promise<string[]>} champion IDs to exclude
 */
async function getCrossGameExclusions(session, currentDraft) {
  if (!session || session.draft_mode === "standard") return [];
  if (!currentDraft || !currentDraft.game_number) return [];

  const priorDrafts = await NavigatorDraft.findAll({
    where: { session_id: session.id, status: "completed" },
    order: [["game_number", "ASC"]],
  });

  const relevant = priorDrafts.filter(
    (d) => d.game_number < currentDraft.game_number,
  );
  if (relevant.length === 0) return [];

  const includeBans = session.draft_mode === "ironman";
  const eventTypes = includeBans ? ["pick", "ban"] : ["pick"];

  const events = await NavigatorEvent.findAll({
    where: {
      navigator_draft_id: relevant.map((d) => d.id),
      event_type: eventTypes,
    },
  });

  return Array.from(new Set(events.map((e) => e.champion_id)));
}

module.exports = { getCrossGameExclusions };
