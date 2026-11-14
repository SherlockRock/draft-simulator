/**
 * Every database read and write the esclub sync needs (S2 Task 6), through
 * Sequelize. Each function takes an optional transaction as its last
 * argument. The sync (sync.js) talks to the database only through this
 * module, so tests can swap in an in-memory store.
 *
 * Reads are flat queries (no hasMany include next to a LIMIT, so no
 * subquery); a series and its games are two queries, not a join.
 *
 * The rules of what a write may change live in two pure functions
 * (`seriesAttributes`, `partitionGames`) that the in-memory test store
 * reuses, so they are tested once.
 */

const { Op, QueryTypes } = require("sequelize");
const sequelize = require("../../config/database");
const Tournament = require("../../models/Tournament");
const Team = require("../../models/Team");
const TeamPlayer = require("../../models/TeamPlayer");
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const { deriveRoster, teamRowFromRoster, gameIsComplete } = require("./derive");
const { EsclubSyncAbandoned } = require("./errors");

const opts = (transaction) => (transaction ? { transaction } : {});

const GAME_READ_ATTRIBUTES = [
  "id",
  "series_id",
  "external_match_id",
  "number",
  "complete",
  "winner",
  "blue_side_team",
  "participants",
];

/**
 * Run `fn` in one database transaction.
 * @template T
 * @param {(transaction: object) => Promise<T>} fn
 * @param {string} [syncId] lock and verify the owner before any mirror write
 * @returns {Promise<T>}
 */
function inTransaction(fn, syncId) {
  return sequelize.transaction(async (transaction) => {
    if (syncId !== undefined) {
      const rows = await sequelize.query(
        'SELECT status FROM "EsclubSyncs" WHERE id = :syncId FOR UPDATE',
        { replacements: { syncId }, type: QueryTypes.SELECT, transaction },
      );
      if (rows[0]?.status !== "running") throw new EsclubSyncAbandoned("sync no longer running");
    }
    return fn(transaction);
  });
}

/**
 * A tournament and its stages (oldest first), as plain objects.
 * @param {string} tournamentId
 * @param {object} [transaction]
 * @returns {Promise<(object & { stages: object[] }) | null>}
 */
async function loadTournamentWithStages(tournamentId, transaction) {
  const tournament = await Tournament.findByPk(tournamentId, { raw: true, ...opts(transaction) });
  if (!tournament) return null;
  const stages = await LeagueStage.findAll({
    where: { tournament_id: tournamentId },
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    raw: true,
    ...opts(transaction),
  });
  return { ...tournament, stages };
}

/**
 * The mirrored rows for some external series ids, with each one's games
 * (external_match_id, complete flag, winner, blue side, participants: what
 * completeness needs). Two queries; none for no ids.
 * @param {string[]} externalIds
 * @param {object} [transaction]
 * @returns {Promise<Map<string, object>>} external id -> series row with `games`
 */
async function loadSeriesByExternalIds(externalIds, transaction) {
  const out = new Map();
  if (externalIds.length === 0) return out;
  const series = await LeagueSeries.findAll({
    where: { external_id: { [Op.in]: externalIds } },
    raw: true,
    ...opts(transaction),
  });
  if (series.length === 0) return out;
  const games = await LeagueGame.findAll({
    where: { series_id: { [Op.in]: series.map((s) => s.id) } },
    attributes: GAME_READ_ATTRIBUTES,
    order: [["number", "ASC"]],
    raw: true,
    ...opts(transaction),
  });
  for (const row of series) out.set(row.external_id, { ...row, games: [] });
  const byId = new Map(series.map((s) => [s.id, out.get(s.external_id)]));
  for (const g of games) byId.get(g.series_id).games.push(g);
  return out;
}

/**
 * One series with its stage, tournament, both teams and games, for a
 * single-series refresh.
 * @param {string} seriesId
 * @param {object} [transaction]
 * @returns {Promise<{ series: object, stage: object, tournament: object, team1: object|null, team2: object|null, games: object[] } | null>}
 */
async function loadSeriesForRefresh(seriesId, transaction) {
  const row = await LeagueSeries.findByPk(seriesId, {
    include: [
      { model: LeagueStage, as: "Stage" },
      { model: Tournament },
      { model: Team, as: "Team1" },
      { model: Team, as: "Team2" },
    ],
    ...opts(transaction),
  });
  if (!row) return null;
  const { Stage, Tournament: tournament, Team1, Team2, ...series } = row.get({ plain: true });
  const games = await LeagueGame.findAll({
    where: { series_id: seriesId },
    attributes: GAME_READ_ATTRIBUTES,
    order: [["number", "ASC"]],
    raw: true,
    ...opts(transaction),
  });
  return { series, stage: Stage, tournament, team1: Team1 ?? null, team2: Team2 ?? null, games };
}

/**
 * Team rows of a tournament by external (roster) id.
 * @param {string} tournamentId
 * @param {string[]} externalIds
 * @param {object} [transaction]
 * @returns {Promise<Map<string, object>>}
 */
async function loadTeamsByExternalIds(tournamentId, externalIds, transaction) {
  const out = new Map();
  if (externalIds.length === 0) return out;
  const teams = await Team.findAll({
    where: { tournament_id: tournamentId, external_id: { [Op.in]: externalIds } },
    raw: true,
    ...opts(transaction),
  });
  for (const t of teams) out.set(t.external_id, t);
  return out;
}

/**
 * Insert or update the stage's teams by (tournament_id, external_id), in one
 * transaction (the caller's when given). A team missing from `refs` is left
 * alone. Rows are checked by assertTeamInvariants before any write.
 * @param {{id: string, region: string, source: string}} tournament
 * @param {import("./normalize").ExternalTeamRef[]} refs
 * @param {object} [transaction]
 * @returns {Promise<Map<string, object>>} external id -> Team row
 */
async function upsertStageTeams(tournament, refs, transaction) {
  const distinct = [...new Map(refs.map((r) => [r.externalId, r])).values()];
  if (distinct.length === 0) return new Map();
  const rows = distinct.map((ref) => teamRowFromRoster(ref, tournament));
  const run = async (tx) => {
    const found = await Team.findAll({
      where: { tournament_id: tournament.id, external_id: { [Op.in]: rows.map((r) => r.external_id) } },
      transaction: tx,
    });
    const byExternal = new Map(found.map((t) => [t.external_id, t]));
    const out = new Map();
    for (const row of rows) {
      const existing = byExternal.get(row.external_id);
      out.set(row.external_id, existing ? await existing.update(row, { transaction: tx }) : await Team.create(row, { transaction: tx }));
    }
    return out;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * The attributes of a LeagueSeries row for a write.
 *  - teams are set only when both are known, and never change once set;
 *  - draft_type keeps the stored value when the new one is null;
 *  - finished_at is stamped the first time the series is complete;
 *  - a complete series stays complete.
 * @param {object | null} existing the stored row (plain), or null
 * @param {{ tournamentId: string, stageId: string, serie: object, team1Id: string|null, team2Id: string|null, complete: boolean, now: Date }} input
 * @returns {object}
 */
function seriesAttributes(existing, { tournamentId, stageId, serie, team1Id, team2Id, complete, now }) {
  if (existing?.complete) return { ...existing };
  const hadTeams = Boolean(existing && existing.team1_id && existing.team2_id);
  const gainTeams = !hadTeams && Boolean(team1Id && team2Id);
  const complete1 = Boolean(complete || (existing && existing.complete));
  return {
    tournament_id: tournamentId,
    stage_id: stageId,
    external_id: serie.externalId,
    parent_type: serie.parentType,
    number: serie.number,
    best_of: serie.bestOf,
    esclub_status: serie.esclubStatus,
    status: serie.status,
    starts_at: serie.startsAt,
    draft_type: serie.draftType ?? (existing ? existing.draft_type : null) ?? null,
    ...(hadTeams
      ? { team1_id: existing.team1_id, team2_id: existing.team2_id }
      : { team1_id: gainTeams ? team1Id : null, team2_id: gainTeams ? team2Id : null }),
    complete: complete1,
    finished_at: (existing && existing.finished_at) || (complete1 ? now : null),
    last_synced_at: now,
  };
}

function gameAttributes(seriesId, game) {
  return {
    series_id: seriesId,
    external_match_id: game.externalMatchId,
    number: game.number,
    picks: game.picks,
    first_pick: game.firstPick,
    blue_side_team: game.blueSideTeam,
    winner: game.winner,
    participants: game.participants,
    substitutions: game.substitutions,
    unmatched_participants: game.unmatchedParticipants,
    played_at: game.playedAt,
    complete: gameIsComplete(game),
  };
}

/**
 * Which games to insert, which to rewrite and which to leave alone: a stored
 * game whose `complete` is true is never touched.
 * @param {string} seriesId
 * @param {{ id: string, external_match_id: string, complete: boolean }[]} existing the series' stored games
 * @param {import("./normalize").NormalizedGame[]} games
 * @returns {{ create: object[], update: { id: string, row: object }[], untouched: string[] }}
 */
function partitionGames(seriesId, existing, games) {
  const byMatch = new Map(existing.map((g) => [g.external_match_id, g]));
  const out = { create: [], update: [], untouched: [] };
  for (const game of games) {
    const stored = byMatch.get(game.externalMatchId);
    const row = gameAttributes(seriesId, game);
    if (!stored) out.create.push(row);
    else if (stored.complete) out.untouched.push(game.externalMatchId);
    else out.update.push({ id: stored.id, row });
  }
  return out;
}

/**
 * Upsert one series by external id and its games by external match id.
 * Never rewrites a stored complete game; never changes teams once set.
 * @param {{ tournament: {id: string}, stage: {id: string}, serie: object, team1: {id: string}|null, team2: {id: string}|null, games: object[], complete: boolean, now: Date }} input
 *   `serie`: { externalId, parentType, number, esclubStatus, status, bestOf, draftType, startsAt }
 * @param {object} [transaction]
 * @returns {Promise<{ series: object, gamesWritten: number, gamesLeftAlone: number, unchanged?: boolean }>}
 */
async function writeSeries({ tournament, stage, serie, team1, team2, games = [], complete, now }, transaction) {
  const existing = await LeagueSeries.findOne({ where: { external_id: serie.externalId }, ...opts(transaction) });
  if (existing?.complete) {
    return { series: existing.get({ plain: true }), gamesWritten: 0, gamesLeftAlone: games.length, unchanged: true };
  }
  const attrs = seriesAttributes(existing ? existing.get({ plain: true }) : null, {
    tournamentId: tournament.id,
    stageId: stage.id,
    serie,
    team1Id: team1 ? team1.id : null,
    team2Id: team2 ? team2.id : null,
    complete,
    now,
  });
  const row = existing ? await existing.update(attrs, opts(transaction)) : await LeagueSeries.create(attrs, opts(transaction));

  let gamesWritten = 0;
  let gamesLeftAlone = 0;
  if (games.length > 0) {
    const stored = existing
      ? await LeagueGame.findAll({
          where: { series_id: row.id },
          attributes: ["id", "external_match_id", "complete"],
          raw: true,
          ...opts(transaction),
        })
      : [];
    const { create, update, untouched } = partitionGames(row.id, stored, games);
    for (const u of update) {
      // `complete: false` in the WHERE is a second guard: a game that completed
      // meanwhile is never overwritten.
      await LeagueGame.update(u.row, { where: { id: u.id, complete: false }, ...opts(transaction), logging: false });
    }
    if (create.length > 0) await LeagueGame.bulkCreate(create, { ...opts(transaction), logging: false });
    gamesWritten = create.length + update.length;
    gamesLeftAlone = untouched.length;
  }
  return { series: row.get({ plain: true }), gamesWritten, gamesLeftAlone };
}

/**
 * Replace one team's TeamPlayer rows with the roster derived from every game
 * of the tournament that the team played (D10). Scoped to that team_id.
 * @param {{id: string}} team
 * @param {string} tournamentId
 * @param {object} [transaction]
 * @returns {Promise<number>} players written
 */
async function rebuildRoster(team, tournamentId, transaction) {
  const series = await LeagueSeries.findAll({
    where: {
      tournament_id: tournamentId,
      [Op.or]: [{ team1_id: team.id }, { team2_id: team.id }],
    },
    attributes: ["id", "team1_id"],
    raw: true,
    ...opts(transaction),
  });
  let players = [];
  if (series.length > 0) {
    const team1Of = new Map(series.map((s) => [s.id, s.team1_id]));
    const games = await LeagueGame.findAll({
      where: { series_id: { [Op.in]: series.map((s) => s.id) } },
      attributes: ["series_id", "blue_side_team", "played_at", "participants"],
      order: [["played_at", "ASC"], ["external_match_id", "ASC"]],
      raw: true,
      ...opts(transaction),
    });
    players = deriveRoster(
      games.map((g) => ({
        teamNumber: team1Of.get(g.series_id) === team.id ? 1 : 2,
        game: {
          blueSideTeam: g.blue_side_team,
          playedAt: g.played_at ? new Date(g.played_at).toISOString() : null,
          participants: g.participants,
        },
      })),
    );
  }
  await TeamPlayer.destroy({ where: { team_id: team.id }, ...opts(transaction), logging: false });
  if (players.length > 0) {
    await TeamPlayer.bulkCreate(
      players.map((p) => ({ team_id: team.id, role: p.role, gameName: p.gameName, tagLine: p.tagLine, ordinal: p.ordinal })),
      { ...opts(transaction), logging: false },
    );
  }
  return players.length;
}

/**
 * Stamp the stage's and the tournament's last_synced_at.
 * @param {{id: string}} stage
 * @param {{id: string}} tournament
 * @param {Date} now
 * @param {object} [transaction]
 * @returns {Promise<void>}
 */
async function touchSynced(stage, tournament, now, transaction) {
  await LeagueStage.update({ last_synced_at: now }, { where: { id: stage.id }, ...opts(transaction) });
  await Tournament.update({ last_synced_at: now }, { where: { id: tournament.id }, ...opts(transaction) });
}

module.exports = {
  inTransaction,
  loadTournamentWithStages,
  loadSeriesByExternalIds,
  loadSeriesForRefresh,
  loadTeamsByExternalIds,
  upsertStageTeams,
  seriesAttributes,
  partitionGames,
  writeSeries,
  rebuildRoster,
  touchSynced,
};
