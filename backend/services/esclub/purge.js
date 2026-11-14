/** Tournament-scoped deletion of the esclub mirror; sync history survives. */
const { QueryTypes } = require("sequelize");
const sequelize = require("../../config/database");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("tournament id must be a UUID");
}

function select(sql, tournamentId, transaction) {
  return sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements: { tournamentId },
    ...(transaction ? { transaction } : {}),
  });
}

function notFound() {
  const error = new Error("esclub tournament not found");
  error.name = "EsclubTournamentNotFound";
  return error;
}

async function preview(tournamentId, transaction) {
  const rows = await select(
    `SELECT t.id, t.name,
       (SELECT COUNT(*)::int FROM "LeagueGames" g
         WHERE g.series_id IN (SELECT id FROM "LeagueSeries" WHERE tournament_id = :tournamentId)) AS games,
       (SELECT COUNT(*)::int FROM "LeagueSeries" WHERE tournament_id = :tournamentId) AS series,
       (SELECT COUNT(*)::int FROM "LeagueStages" WHERE tournament_id = :tournamentId) AS stages,
       (SELECT COUNT(*)::int FROM "TeamPlayers" p
         WHERE p.team_id IN (SELECT id FROM "Teams" WHERE tournament_id = :tournamentId)) AS "teamPlayers",
       (SELECT COUNT(*)::int FROM "Teams" WHERE tournament_id = :tournamentId) AS teams,
       (SELECT COUNT(*)::int FROM "UserTournaments" WHERE tournament_id = :tournamentId) AS "userTournaments"
     FROM "Tournaments" t WHERE t.id = :tournamentId AND t.source = 'esclub'`,
    tournamentId,
    transaction,
  );
  const row = rows[0];
  if (!row) throw notFound();
  return {
    tournament: { id: row.id, name: row.name },
    counts: {
      games: row.games,
      series: row.series,
      stages: row.stages,
      teamPlayers: row.teamPlayers,
      teams: row.teams,
      userTournaments: row.userTournaments,
      tournaments: 1,
    },
  };
}

/**
 * Count the rows a purge would remove, including cascading user links. Reads
 * only ids, the tournament name and counts; does not open a transaction.
 * @param {string} tournamentId the local tournament UUID
 * @returns {Promise<{ tournament: { id: string, name: string }, counts: object }>}
 */
async function previewPurge(tournamentId) {
  checkId(tournamentId);
  return preview(tournamentId);
}

/**
 * Purge one esclub tournament in FK-safe order, in one transaction. The CLI
 * calls this only after printing previewPurge and receiving --yes. Existing
 * FK actions clear canvas team links, cascade UserTournaments, and SET NULL
 * the sync-log references. No sync or daily-usage row is deleted.
 *
 * The sync-table lock prevents a new sync from starting between the running
 * check and commit. A running sync for this tournament, or an add whose target
 * is not yet known, refuses the purge; other tournaments' data is untouched.
 * @param {string} tournamentId the local tournament UUID
 * @returns {Promise<{ tournament: { id: string, name: string }, counts: object }>}
 */
async function purgeTournament(tournamentId) {
  checkId(tournamentId);
  return sequelize.transaction(async (transaction) => {
    // Transaction control only: this does not modify any sync-log row.
    await sequelize.query('LOCK TABLE "EsclubSyncs" IN SHARE ROW EXCLUSIVE MODE', { transaction });
    const running = await select(
      `SELECT id FROM "EsclubSyncs" WHERE status = 'running'
         AND (tournament_id = :tournamentId OR tournament_id IS NULL) LIMIT 1`,
      tournamentId,
      transaction,
    );
    if (running.length) {
      const error = new Error("a sync is running; wait for it to finish or unlock a stale sync");
      error.name = "EsclubPurgeBusy";
      throw error;
    }
    const target = await select(
      `SELECT id FROM "Tournaments" WHERE id = :tournamentId AND source = 'esclub' FOR UPDATE`,
      tournamentId,
      transaction,
    );
    if (!target.length) throw notFound();
    const planned = await preview(tournamentId, transaction);
    const deletes = [
      `DELETE FROM "LeagueGames" WHERE series_id IN
         (SELECT id FROM "LeagueSeries" WHERE tournament_id = :tournamentId)`,
      `DELETE FROM "LeagueSeries" WHERE tournament_id = :tournamentId`,
      `DELETE FROM "LeagueStages" WHERE tournament_id = :tournamentId`,
      `DELETE FROM "TeamPlayers" WHERE team_id IN
         (SELECT id FROM "Teams" WHERE tournament_id = :tournamentId)`,
      `DELETE FROM "Teams" WHERE tournament_id = :tournamentId`,
      `DELETE FROM "Tournaments" WHERE id = :tournamentId AND source = 'esclub'`,
    ];
    for (const sql of deletes) {
      await sequelize.query(sql, { replacements: { tournamentId }, transaction });
    }
    return planned;
  });
}

module.exports = { previewPurge, purgeTournament };
