const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");

// Keep empty league teams in the result; restrict series to their tournament.
const RECORD_SQL = `SELECT t.id AS team_id, tournament.source,
  s.id AS series_id, s.best_of,
  CASE WHEN s.team1_id = t.id THEN 1 ELSE 2 END AS team_number,
  g.blue_side_team, g.winner
FROM "Teams" t
LEFT JOIN "Tournaments" tournament ON tournament.id = t.tournament_id
LEFT JOIN "LeagueSeries" s ON tournament.source = 'esclub'
  AND s.tournament_id = tournament.id
  AND (s.team1_id = t.id OR s.team2_id = t.id)
LEFT JOIN "LeagueGames" g ON g.series_id = s.id
WHERE t.id IN (:teamIds)`;

const emptyRecord = () => ({ series: { won: 0, lost: 0 }, games: { won: 0, lost: 0 } });

/** Shared mirror records for already-visible teams, fetched in one query. */
async function teamLeagueRecords(teamIds, { transaction } = {}) {
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return {};
  const rows = await sequelize.query(RECORD_SQL, {
    replacements: { teamIds: ids },
    type: QueryTypes.SELECT,
    transaction,
  });
  const records = Object.fromEntries(ids.map((id) => [id, null]));
  const seriesByTeam = new Map();
  for (const row of rows) {
    if (!Object.hasOwn(records, row.team_id) || row.source !== "esclub") continue;
    records[row.team_id] ??= emptyRecord();
    if (!row.series_id) continue;
    let series = seriesByTeam.get(row.team_id);
    if (!series) {
      series = new Map();
      seriesByTeam.set(row.team_id, series);
    }
    let score = series.get(row.series_id);
    if (!score) {
      score = { won: 0, lost: 0, bestOf: Number(row.best_of) };
      series.set(row.series_id, score);
    }
    if (row.winner == null) continue;
    const side = Number(row.blue_side_team) === Number(row.team_number) ? "blue" : "red";
    const outcome = row.winner === side ? "won" : "lost";
    score[outcome]++;
    records[row.team_id].games[outcome]++;
  }
  for (const [teamId, series] of seriesByTeam) {
    for (const score of series.values()) {
      if (score.won > score.bestOf / 2) records[teamId].series.won++;
      else if (score.lost > score.bestOf / 2) records[teamId].series.lost++;
    }
  }
  return records;
}

module.exports = { teamLeagueRecords };
