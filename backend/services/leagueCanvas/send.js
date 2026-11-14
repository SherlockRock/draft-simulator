// The DB side of sending mirrored league series to a canvas (S3 plan D2–D5,
// D11): `POST /api/canvas/:canvasId/import/league-series`. Reads the mirror
// only (no esclub client), plans each series with the pure planner and writes
// the canvas series in one transaction that first locks the Canvas row, so two
// sends of the same series to one canvas can't both create a group (D4).
//
// No player data is read: the game load names its columns and never selects
// `participants`; nothing here copies a participant, player key or Riot ID.

const { Canvas, CanvasGroup, CanvasDraft } = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const LeagueStage = require("../../models/LeagueStage");
const Team = require("../../models/Team");
const UserTournament = require("../../models/UserTournament");
const teamAccess = require("../teamAccess");
const { generateUniqueCanvasGroupName } = require("../../helpers");
const { planSend, bulkOrder, columnPositions } = require("./plan");

const MAX_SERIES_PER_SEND = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What planSend reads, and the stage name. No external ids, no sync state.
const SERIES_ATTRIBUTES = [
  "id",
  "tournament_id",
  "number",
  "team1_id",
  "team2_id",
  "best_of",
  "draft_type",
  "starts_at",
  "status",
  "complete",
];
const TEAM_ATTRIBUTES = ["id", "name", "source", "owner_id"];
// Never `participants`, `substitutions` or `external_match_id`.
const GAME_ATTRIBUTES = [
  "series_id",
  "number",
  "picks",
  "first_pick",
  "blue_side_team",
  "winner",
  "complete",
  "played_at",
];

/** The canvas the send targets is gone (the route answers 404). */
class CanvasNotFoundError extends Error {
  constructor() {
    super("Canvas not found");
    this.name = "CanvasNotFoundError";
  }
}

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Validate the send body before any query (D5): 1..50 UUID strings without
 * duplicates (compared lowercased) and finite `positionX` / `positionY`.
 * `rowStep` is optional: a finite number passes through (clamped later by
 * `columnPositions`); anything else becomes `undefined`, the default step.
 * @param {object} body the request body
 * @returns {{ ok: true, value: { leagueSeriesIds: string[], positionX: number, positionY: number, rowStep: number|undefined } } | { ok: false, error: string }}
 */
function validateSendBody(body) {
  const { leagueSeriesIds, positionX, positionY, rowStep } = body || {};
  if (!Array.isArray(leagueSeriesIds)) {
    return { ok: false, error: "leagueSeriesIds must be an array" };
  }
  if (
    leagueSeriesIds.length < 1 ||
    leagueSeriesIds.length > MAX_SERIES_PER_SEND
  ) {
    return {
      ok: false,
      error: `leagueSeriesIds must hold 1 to ${MAX_SERIES_PER_SEND} ids`,
    };
  }
  if (
    !leagueSeriesIds.every(
      (id) => typeof id === "string" && UUID_PATTERN.test(id),
    )
  ) {
    return { ok: false, error: "leagueSeriesIds must be UUIDs" };
  }
  const ids = leagueSeriesIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "leagueSeriesIds must not repeat" };
  }
  if (!isFiniteNumber(positionX) || !isFiniteNumber(positionY)) {
    return { ok: false, error: "positionX and positionY must be numbers" };
  }
  // D5: the server falls back to the default step when the client gives no
  // usable one. Anything but a finite number (absent, null, a string, NaN)
  // counts as absent, as in `columnPositions`; it never refuses the send.
  return {
    ok: true,
    value: {
      leagueSeriesIds: ids,
      positionX,
      positionY,
      rowStep: isFiniteNumber(rowStep) ? rowStep : undefined,
    },
  };
}

/**
 * Lock the Canvas row (`SELECT … FOR UPDATE`) for the rest of the transaction.
 * @param {string} canvasId
 * @param {object} transaction
 * @returns {Promise<object|null>} the row, or null when the canvas is gone
 */
function lockCanvas(canvasId, transaction) {
  return Canvas.findOne({
    where: { id: canvasId },
    attributes: ["id"],
    lock: true,
    transaction,
  });
}

/**
 * The mirror series with their two teams and stage name (LEFT joins: a series
 * whose members haven't replied has no teams yet and is refused later).
 * @param {string[]} ids
 * @param {object} transaction
 * @returns {Promise<object[]>} plain rows, `Team1` / `Team2` / `Stage` nested
 */
function loadSeries(ids, transaction) {
  return LeagueSeries.findAll({
    where: { id: ids },
    attributes: SERIES_ATTRIBUTES,
    include: [
      { model: Team, as: "Team1", attributes: TEAM_ATTRIBUTES, required: false },
      { model: Team, as: "Team2", attributes: TEAM_ATTRIBUTES, required: false },
      { model: LeagueStage, as: "Stage", attributes: ["name"], required: false },
    ],
    raw: true,
    nest: true,
    transaction,
  });
}

/**
 * The mirror games of these series: the listed columns only, never
 * `participants`.
 * @param {string[]} ids series ids
 * @param {object} transaction
 * @returns {Promise<object[]>} plain rows
 */
function loadGames(ids, transaction) {
  return LeagueGame.findAll({
    where: { series_id: ids },
    attributes: GAME_ATTRIBUTES,
    raw: true,
    transaction,
  });
}

/**
 * The groups on THIS canvas that already hold one of these series (D4): one
 * query, canvas pinned, inner join to the VersusDraft on `league_series_id`.
 * @param {string} canvasId
 * @param {string[]} ids series ids
 * @param {object} transaction
 * @returns {Promise<Map<string, string>>} series id → the first group's id
 */
async function findExistingGroups(canvasId, ids, transaction) {
  const groups = await CanvasGroup.findAll({
    where: { canvas_id: canvasId },
    attributes: ["id"],
    include: [
      {
        model: VersusDraft,
        attributes: ["league_series_id"],
        where: { league_series_id: ids },
        required: true,
      },
    ],
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    raw: true,
    nest: true,
    transaction,
  });
  const bySeries = new Map();
  for (const group of groups) {
    const seriesId = group.VersusDraft && group.VersusDraft.league_series_id;
    if (seriesId && !bySeries.has(seriesId)) bySeries.set(seriesId, group.id);
  }
  return bySeries;
}

/**
 * Put each league on the sender's Teams page (combined plan R3): one INSERT …
 * ON CONFLICT DO NOTHING, so an existing row, archived or not, is untouched.
 * @param {string} userId
 * @param {string[]} tournamentIds distinct
 * @param {object} transaction
 * @returns {Promise<void>}
 */
async function ensureUserTournaments(userId, tournamentIds, transaction) {
  if (tournamentIds.length === 0) return;
  await UserTournament.bulkCreate(
    tournamentIds.map((tournamentId) => ({
      user_id: userId,
      tournament_id: tournamentId,
      archived_at: null,
    })),
    { ignoreDuplicates: true, transaction },
  );
}

// Writes one planned series: VersusDraft, Drafts, the group, the locked cards.
async function writeSeries({ plan, canvasId, position, transaction }) {
  const versusDraft = await VersusDraft.create(plan.versusDraft, {
    transaction,
  });
  const draftIdByIndex = new Map();
  for (const row of plan.drafts) {
    const draft = await Draft.create(
      { ...row, versus_draft_id: versusDraft.id },
      { transaction },
    );
    draftIdByIndex.set(row.seriesIndex, draft.id);
  }
  const name = await generateUniqueCanvasGroupName(
    plan.group.name,
    canvasId,
    transaction,
  );
  const group = await CanvasGroup.create(
    {
      ...plan.group,
      name,
      canvas_id: canvasId,
      versus_draft_id: versusDraft.id,
      positionX: position.x,
      positionY: position.y,
    },
    { transaction },
  );
  for (const card of plan.cards) {
    await CanvasDraft.create(
      {
        canvas_id: canvasId,
        draft_id: draftIdByIndex.get(card.seriesIndex),
        group_id: group.id,
        positionX: card.positionX,
        positionY: card.positionY,
        is_locked: card.is_locked,
        source_type: card.source_type,
      },
      { transaction },
    );
  }
  return group.id;
}

/**
 * Send mirrored league series to a canvas (D2–D5). One transaction: lock the
 * Canvas row, read the series and games, skip what is already on this canvas
 * (`existing`) or can't be sent (`skipped`, with planSend's reason,
 * "not-found" or "not-linkable"), then write the rest as a column at the drop
 * point, newest first, and the sender's UserTournaments rows. Access is the
 * caller's job; so are the timestamp, snapshot and broadcast.
 * @param {{ canvasId: string, userId: string, leagueSeriesIds: string[], positionX: number, positionY: number, rowStep?: number }} input validated
 * @returns {Promise<{ created: { leagueSeriesId: string, groupId: string }[], existing: { leagueSeriesId: string, groupId: string }[], skipped: { leagueSeriesId: string, reason: string }[] }>}
 * @throws {CanvasNotFoundError} when the canvas is gone (rolled back)
 */
async function sendLeagueSeries({
  canvasId,
  userId,
  leagueSeriesIds,
  positionX,
  positionY,
  rowStep,
}) {
  const transaction = await Canvas.sequelize.transaction();
  try {
    const canvas = await lockCanvas(canvasId, transaction);
    if (!canvas) throw new CanvasNotFoundError();

    const seriesRows = await loadSeries(leagueSeriesIds, transaction);
    const gameRows = await loadGames(leagueSeriesIds, transaction);
    const existingBySeries = await findExistingGroups(
      canvasId,
      leagueSeriesIds,
      transaction,
    );

    const seriesById = new Map(seriesRows.map((s) => [s.id, s]));
    const gamesBySeries = new Map();
    for (const game of gameRows) {
      const list = gamesBySeries.get(game.series_id) || [];
      list.push(game);
      gamesBySeries.set(game.series_id, list);
    }

    const existing = [];
    const skipped = [];
    const sendable = [];
    const now = new Date();
    for (const id of leagueSeriesIds) {
      const series = seriesById.get(id);
      if (!series) {
        skipped.push({ leagueSeriesId: id, reason: "not-found" });
        continue;
      }
      if (existingBySeries.has(id)) {
        existing.push({ leagueSeriesId: id, groupId: existingBySeries.get(id) });
        continue;
      }
      const plan = planSend(series, gamesBySeries.get(id) || [], {
        senderId: userId,
        now,
      });
      if (plan.refused) {
        skipped.push({ leagueSeriesId: id, reason: plan.refused });
        continue;
      }
      // D11: never link a team the sender couldn't link by hand.
      if (
        !teamAccess.canLinkTeam(series.Team1, userId) ||
        !teamAccess.canLinkTeam(series.Team2, userId)
      ) {
        skipped.push({ leagueSeriesId: id, reason: "not-linkable" });
        continue;
      }
      sendable.push({ series, plan });
    }

    const planBySeries = new Map(sendable.map((s) => [s.series.id, s.plan]));
    const ordered = bulkOrder(sendable.map((s) => s.series));
    const positions = columnPositions(
      { positionX, positionY },
      ordered.length,
      rowStep,
    );

    const created = [];
    for (const [i, series] of ordered.entries()) {
      const groupId = await writeSeries({
        plan: planBySeries.get(series.id),
        canvasId,
        position: positions[i],
        transaction,
      });
      created.push({ leagueSeriesId: series.id, groupId });
    }

    const tournamentIds = [...new Set(ordered.map((s) => s.tournament_id))];
    await ensureUserTournaments(userId, tournamentIds, transaction);

    await transaction.commit();
    return { created, existing, skipped };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
}

module.exports = {
  MAX_SERIES_PER_SEND,
  CanvasNotFoundError,
  validateSendBody,
  lockCanvas,
  loadSeries,
  loadGames,
  findExistingGroups,
  ensureUserTournaments,
  sendLeagueSeries,
};
