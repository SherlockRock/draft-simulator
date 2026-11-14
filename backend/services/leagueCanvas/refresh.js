// The DB side of "Refresh from league" on a canvas series group (S3 plan D6,
// D12, answers Q2 B and Q3 A):
// `POST /api/canvas/:canvasId/group/:groupId/league-refresh`. Reads the mirror
// only (no esclub client): appends a Draft and a locked card for each mirror
// game the series lacks, lets existing games follow the mirror (picks, sides,
// first pick; the winner fills and is never cleared), and rewrites the group's
// team names from the linked teams. Never moves a card or the group.
//
// One transaction locks the group row and then the series' VersusDraft row
// before the Drafts are read, so two presses can't both append the same game.
// No player data is read: the game load never selects `participants`.

const { Canvas, CanvasGroup, CanvasDraft } = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");
const LeagueSeries = require("../../models/LeagueSeries");
const Team = require("../../models/Team");
const { withoutPlaceholderTeamNames } = require("../../utils/teamPlaceholders");
const { planRefresh } = require("./plan");
const { loadGames } = require("./send");

const TEAM_NAME_KEYS = ["blueTeamName", "redTeamName"];

/** The group isn't on this canvas, or is gone (the route answers 404). */
class GroupNotFoundError extends Error {
  constructor() {
    super("Group not found");
    this.name = "GroupNotFoundError";
  }
}

/**
 * The group isn't a series sent from the mirror, or its link was purged
 * (`league_series_id` NULL): the route answers 400.
 */
class NotImportedSeriesError extends Error {
  constructor() {
    super("Not an imported series");
    this.name = "NotImportedSeriesError";
  }
}

/**
 * Lock the group row (`SELECT … FOR UPDATE`), pinned to the canvas, so the
 * metadata names rewrite can't interleave with another refresh.
 * @param {string} canvasId
 * @param {string} groupId
 * @param {object} transaction
 * @returns {Promise<object|null>} the plain row, or null
 */
function lockGroup(canvasId, groupId, transaction) {
  return CanvasGroup.findOne({
    where: { id: groupId, canvas_id: canvasId },
    attributes: ["id", "canvas_id", "type", "versus_draft_id", "metadata"],
    lock: true,
    raw: true,
    transaction,
  });
}

/**
 * Lock the series' VersusDraft row (`SELECT … FOR UPDATE`) before its Drafts
 * are read, so concurrent refreshes of one series serialise (D6).
 * @param {string} versusDraftId
 * @param {object} transaction
 * @returns {Promise<object|null>} the plain row, or null
 */
function lockVersusDraft(versusDraftId, transaction) {
  return VersusDraft.findOne({
    where: { id: versusDraftId },
    attributes: [
      "id",
      "name",
      "owner_id",
      "blueTeamName",
      "redTeamName",
      "league_series_id",
    ],
    lock: true,
    raw: true,
    transaction,
  });
}

/**
 * Every Draft of the series, cards dragged out of the group included (D12),
 * with the columns planRefresh compares.
 * @param {string} versusDraftId
 * @param {object} transaction
 * @returns {Promise<object[]>} plain rows
 */
function loadSeriesDrafts(versusDraftId, transaction) {
  return Draft.findAll({
    where: { versus_draft_id: versusDraftId },
    attributes: [
      "id",
      "seriesIndex",
      "picks",
      "firstPick",
      "blueSideTeam",
      "winner",
      "completed",
    ],
    order: [["seriesIndex", "ASC"]],
    raw: true,
    transaction,
  });
}

/**
 * The cards in the group on this canvas, for the append position.
 * @param {string} canvasId
 * @param {string} groupId
 * @param {object} transaction
 * @returns {Promise<object[]>} plain rows
 */
function loadGroupCards(canvasId, groupId, transaction) {
  return CanvasDraft.findAll({
    where: { canvas_id: canvasId, group_id: groupId },
    attributes: ["id", "draft_id", "positionX", "positionY"],
    raw: true,
    transaction,
  });
}

/**
 * The mirror series' status and its linked teams' current names (LEFT joins:
 * public columns only, no roster).
 * @param {string} seriesId
 * @param {object} transaction
 * @returns {Promise<object|null>} plain row, `Team1` / `Team2` nested
 */
function loadSeriesState(seriesId, transaction) {
  return LeagueSeries.findOne({
    where: { id: seriesId },
    attributes: ["id", "status", "complete", "team1_id", "team2_id"],
    include: [
      { model: Team, as: "Team1", attributes: ["id", "name"], required: false },
      { model: Team, as: "Team2", attributes: ["id", "name"], required: false },
    ],
    raw: true,
    nest: true,
    transaction,
  });
}

/**
 * Apply one planned update to a Draft of this series. A picks change bumps
 * `picksVersion` in SQL and clears `lastPickMutationId`, as every other
 * server-side picks writer does, so in-flight client edits on the old version
 * are refused as conflicts.
 * @param {string} versusDraftId the series the Draft must belong to
 * @param {{ id: string, changes: object, picksChanged?: true }} update
 * @param {object} transaction
 * @returns {Promise<void>}
 */
async function updateDraft(versusDraftId, { id, changes, picksChanged }, transaction) {
  const values = picksChanged
    ? {
        ...changes,
        picksVersion: Draft.sequelize.literal('"picksVersion" + 1'),
        lastPickMutationId: null,
      }
    : changes;
  await Draft.update(values, {
    where: { id, versus_draft_id: versusDraftId },
    transaction,
  });
}

/**
 * Write the group's metadata (the caller changed only the two team names).
 * @param {string} canvasId
 * @param {string} groupId
 * @param {object} metadata
 * @param {object} transaction
 * @returns {Promise<void>}
 */
async function updateGroupMetadata(canvasId, groupId, metadata, transaction) {
  await CanvasGroup.update(
    { metadata },
    { where: { id: groupId, canvas_id: canvasId }, transaction },
  );
}

/**
 * Write the VersusDraft's two team-name columns.
 * @param {string} versusDraftId
 * @param {{ blueTeamName: string, redTeamName: string }} names
 * @param {object} transaction
 * @returns {Promise<void>}
 */
async function updateVersusDraftNames(versusDraftId, names, transaction) {
  await VersusDraft.update(names, { where: { id: versusDraftId }, transaction });
}

// The rightmost card of the group, or null when it has none.
function lastCardByX(cards) {
  let last = null;
  for (const card of cards) {
    if (!last || card.positionX > last.positionX) last = card;
  }
  return last ? { positionX: last.positionX, positionY: last.positionY } : null;
}

// The linked teams' current names that are worth storing (team1 is blue in
// the name fields, fix 7); a missing team or a placeholder name is left out.
function currentTeamNames(series) {
  return withoutPlaceholderTeamNames({
    blueTeamName: series.Team1 ? series.Team1.name : undefined,
    redTeamName: series.Team2 ? series.Team2.name : undefined,
  });
}

// The names that differ from what `row` holds; empty when nothing changes.
function changedNames(row, names) {
  const changed = {};
  for (const key of TEAM_NAME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(names, key) && row[key] !== names[key]) {
      changed[key] = names[key];
    }
  }
  return changed;
}

/**
 * Refresh one imported series group from the mirror (D6). One transaction:
 * lock the group (on this canvas) and its VersusDraft, read the series'
 * Drafts, the group's cards, the mirror games and series, apply planRefresh
 * (appends after the rightmost card; updates per Q2 B / Q3 A) and rewrite the
 * team names on the group metadata and VersusDraft when the linked teams'
 * names changed. Access is the caller's job; so are the timestamp, snapshot
 * and broadcast (only when `changed`).
 * @param {{ canvasId: string, groupId: string }} input
 * @returns {Promise<{ changed: boolean, result: { added: number, updated: number, series: { status: string, complete: boolean } } }>}
 * @throws {GroupNotFoundError} the group isn't on this canvas (rolled back)
 * @throws {NotImportedSeriesError} not a series sent from the mirror, or purged (rolled back)
 */
async function refreshLeagueGroup({ canvasId, groupId }) {
  const transaction = await Canvas.sequelize.transaction();
  try {
    const group = await lockGroup(canvasId, groupId, transaction);
    if (!group) throw new GroupNotFoundError();
    if (group.type !== "series" || !group.versus_draft_id) {
      throw new NotImportedSeriesError();
    }
    const versusDraft = await lockVersusDraft(group.versus_draft_id, transaction);
    if (!versusDraft || !versusDraft.league_series_id) {
      throw new NotImportedSeriesError();
    }
    const seriesId = versusDraft.league_series_id;

    const drafts = await loadSeriesDrafts(versusDraft.id, transaction);
    const cards = await loadGroupCards(canvasId, groupId, transaction);
    const games = await loadGames([seriesId], transaction);
    const series = await loadSeriesState(seriesId, transaction);
    if (!series) throw new NotImportedSeriesError();

    const { appends, updates } = planRefresh(drafts, games, {
      lastCard: lastCardByX(cards),
      now: new Date(),
      seriesName: versusDraft.name,
      // Every game of a series belongs to the series' owner, whoever presses.
      senderId: versusDraft.owner_id,
    });

    for (const { draft: row, card } of appends) {
      const draft = await Draft.create(
        { ...row, versus_draft_id: versusDraft.id },
        { transaction },
      );
      await CanvasDraft.create(
        {
          canvas_id: canvasId,
          group_id: groupId,
          draft_id: draft.id,
          positionX: card.positionX,
          positionY: card.positionY,
          is_locked: card.is_locked,
          source_type: card.source_type,
        },
        { transaction },
      );
    }
    for (const update of updates) {
      await updateDraft(versusDraft.id, update, transaction);
    }

    const names = currentTeamNames(series);
    const metadata = group.metadata || {};
    const metadataNames = changedNames(metadata, names);
    const renamedGroup = Object.keys(metadataNames).length > 0;
    if (renamedGroup) {
      await updateGroupMetadata(
        canvasId,
        groupId,
        { ...metadata, ...metadataNames },
        transaction,
      );
    }
    const versusNames = changedNames(versusDraft, names);
    const renamedSeries = Object.keys(versusNames).length > 0;
    if (renamedSeries) {
      await updateVersusDraftNames(
        versusDraft.id,
        {
          blueTeamName: names.blueTeamName ?? versusDraft.blueTeamName,
          redTeamName: names.redTeamName ?? versusDraft.redTeamName,
        },
        transaction,
      );
    }

    await transaction.commit();
    return {
      changed:
        appends.length > 0 || updates.length > 0 || renamedGroup || renamedSeries,
      result: {
        added: appends.length,
        updated: updates.length,
        series: { status: series.status, complete: series.complete },
      },
    };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
}

module.exports = {
  GroupNotFoundError,
  NotImportedSeriesError,
  lockGroup,
  lockVersusDraft,
  loadSeriesDrafts,
  loadGroupCards,
  loadSeriesState,
  updateDraft,
  updateGroupMetadata,
  updateVersusDraftNames,
  refreshLeagueGroup,
};
