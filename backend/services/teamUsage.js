const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");

// Game type of a group, in SQL. This MUST agree with `effectiveGameType` in
// frontend/src/utils/gameClassification.ts (D6): the stored metadata tag when
// it is official/scrim/scratch, else an untagged SERIES group is a scrim, and
// anything else (an untagged custom group) has no type and counts in `total`
// only. If one changes, change the other.
const GAME_TYPE_SQL = `CASE
        WHEN g.metadata->>'gameType' IN ('official', 'scrim', 'scratch') THEN g.metadata->>'gameType'
        WHEN g.type = 'series' THEN 'scrim'
        ELSE NULL
      END`;

const slotSelect = (slot) => `SELECT g.id AS group_id, g.${slot}_id AS team_id, ${GAME_TYPE_SQL} AS game_type
    FROM "CanvasGroups" g
    JOIN "UserCanvases" uc ON uc.canvas_id = g.canvas_id AND uc.user_id = :userId
    WHERE g.${slot}_id IN (:teamIds)`;

// UNION (not UNION ALL) so a group linking one team in both slots is one row.
const USE_COUNTS_SQL = `SELECT team_id,
  COUNT(DISTINCT group_id) FILTER (WHERE game_type = 'official') AS official,
  COUNT(DISTINCT group_id) FILTER (WHERE game_type = 'scrim') AS scrim,
  COUNT(DISTINCT group_id) FILTER (WHERE game_type = 'scratch') AS scratch,
  COUNT(DISTINCT group_id) AS total
FROM (
  ${slotSelect("team1")}
  UNION
  ${slotSelect("team2")}
) linked
GROUP BY team_id`;

/**
 * For each team id: series groups linking it, on canvases userId is a member
 * of (D3), split by game type (Q6).
 * -> { [teamId]: { official, scrim, scratch, total } }
 */
async function teamUseCounts(teamIds, userId, { transaction } = {}) {
  const ids = [...new Set(teamIds)];
  if (!userId || ids.length === 0) return {};

  const rows = await sequelize.query(USE_COUNTS_SQL, {
    replacements: { userId, teamIds: ids },
    type: QueryTypes.SELECT,
    transaction,
  });

  const counts = {};
  for (const id of ids) {
    counts[id] = { official: 0, scrim: 0, scratch: 0, total: 0 };
  }
  for (const row of rows) {
    if (!(row.team_id in counts)) continue;
    counts[row.team_id] = {
      official: Number(row.official),
      scrim: Number(row.scrim),
      scratch: Number(row.scratch),
      total: Number(row.total),
    };
  }
  return counts;
}

module.exports = { teamUseCounts };
